"""SurrealDB-backed ActiveGraph EventStore.

Mirrors the reference SQLite and Postgres stores: one handle per ``run_id``,
``seq`` as the ordering authority, ``UNIQUE(run_id, event_id)``, and an
expected-head check that turns a stale writer into
:class:`~activegraph.store.errors.ConcurrentWriterError`.

Concurrency model
-----------------
Each run has an ``ag_run_head`` record holding ``head_seq`` (highest retained
seq), ``last_seq`` (highest seq ever allocated; never decreases) and
``event_count``. A handle records that head when it is constructed and after
each of its own writes. ``append`` and ``truncate_after``:

1. compare the stored head with the recorded one in Python (a cheap early
   exit), then
2. run one SurrealQL transaction that compares again and ``THROW``s on a
   mismatch before writing the event (or deleting the tail) and advancing the
   head.

A ``THROW`` from step 2 and a SurrealDB ``TransactionConflict`` at commit
(two writers raced on the head record) both surface as
``ConcurrentWriterError`` with ``driver="surrealdb"``. Either way nothing from
the losing transaction is committed.
"""

from __future__ import annotations

from typing import Any, Iterator, Optional

from activegraph.core.event import Event
from activegraph.store.base import RunRecord
from activegraph.store.errors import (
    ConcurrentWriterError,
    DuplicateEventError,
    EventNotFoundError,
)
from activegraph.store.serde import decode_event, encode_event

from ._client import Connection, SurrealQueryError, tagged_result
from .schema import _apply as _apply_schema

DRIVER = "surrealdb"

# THROW markers. Matched as substrings because servers prefix thrown messages
# ("An error occurred: ...") and the embedded engine reports no error kind.
HEAD_MOVED = "activegraph-surrealdb: run head moved"
EVENT_MISSING = "activegraph-surrealdb: event not found"
RUN_EXISTS = "activegraph-surrealdb: run already exists"

_EVENT_ID_INDEX = "ag_event_run_event_id"
_EVENT_SEQ_INDEX = "ag_event_run_seq"

_HEAD_CHECK = f"""
LET $head = (SELECT * FROM ONLY $head_record);
IF $head.head_seq != $expected_head OR ($head.last_seq ?? 0) != $expected_last {{
    THROW "{HEAD_MOVED}";
}};
"""

_APPEND = f"""
BEGIN TRANSACTION;
{_HEAD_CHECK}
CREATE ag_event CONTENT $event;
UPSERT $head_record SET
    run_id = $run_id,
    head_seq = $event.seq,
    last_seq = $event.seq,
    event_count = $expected_count + 1,
    appended_at = time::now();
COMMIT TRANSACTION;
"""

_TRUNCATE = f"""
BEGIN TRANSACTION;
{_HEAD_CHECK}
LET $cut = (SELECT VALUE seq FROM ag_event WHERE run_id = $run_id AND event_id = $event_id)[0];
IF $cut = NONE {{
    THROW "{EVENT_MISSING}";
}};
DELETE ag_event WHERE run_id = $run_id AND seq > $cut;
LET $remaining = (SELECT count() AS n FROM ag_event WHERE run_id = $run_id GROUP ALL)[0].n ?? 0;
UPSERT $head_record SET
    run_id = $run_id,
    head_seq = $cut,
    last_seq = $expected_last,
    event_count = $remaining;
RETURN {{ ag_truncate: true, head_seq: $cut, event_count: $remaining }};
COMMIT TRANSACTION;
"""

_FORK = f"""
BEGIN TRANSACTION;
LET $cut = (SELECT VALUE seq FROM ag_event WHERE run_id = $parent_run_id AND event_id = $at_event_id)[0];
IF $cut = NONE {{
    THROW "{EVENT_MISSING}";
}};
IF (SELECT * FROM ONLY $new_run_record) != NONE
    OR (SELECT * FROM ONLY $new_head_record) != NONE {{
    THROW "{RUN_EXISTS}";
}};
LET $parent = (SELECT * FROM ONLY $parent_run_record);
CREATE $new_run_record CONTENT {{
    run_id: $new_run_id,
    parent_run_id: $parent_run_id,
    forked_at_event_id: $at_event_id,
    label: $label,
    created_at: $created_at,
    goal: $parent.goal,
    frame_id: $parent.frame_id
}};
LET $rows = (SELECT * FROM ag_event WHERE run_id = $parent_run_id AND seq <= $cut ORDER BY seq);
FOR $row IN $rows {{
    CREATE ag_event CONTENT {{
        run_id: $new_run_id,
        seq: $row.seq,
        event_id: $row.event_id,
        type: $row.type,
        actor: $row.actor,
        payload: $row.payload,
        frame_id: $row.frame_id,
        caused_by: $row.caused_by,
        timestamp: $row.timestamp
    }};
}};
CREATE $new_head_record CONTENT {{
    run_id: $new_run_id,
    head_seq: $cut,
    last_seq: $cut,
    event_count: array::len($rows),
    appended_at: time::now()
}};
RETURN {{ ag_fork: true, copied: array::len($rows) }};
COMMIT TRANSACTION;
"""

_UPSERT_RUN = """
UPSERT $run_record SET
    run_id = $run_id,
    parent_run_id = $parent_run_id ?? parent_run_id,
    forked_at_event_id = $forked_at_event_id ?? forked_at_event_id,
    label = $label ?? label,
    created_at = created_at ?? $created_at,
    goal = $goal ?? goal,
    frame_id = $frame_id ?? frame_id;
"""

_PAGE = """
SELECT * FROM ag_event
WHERE run_id = $run_id AND seq > $after_seq AND ($until_seq = NONE OR seq <= $until_seq)
ORDER BY seq
LIMIT $limit;
"""


class SurrealEventStore:
    """Per-run view onto an ActiveGraph event log stored in SurrealDB.

    ``target`` is a URL (``ws://``, ``wss://``, ``http://``, ``https://``,
    ``mem://``, ``surrealkv://<path>``, optionally prefixed ``surrealdb+`` and
    carrying ``?ns=..&db=..``) or an already connected ``surrealdb.Surreal``
    client. A client passed in is borrowed: :meth:`close` leaves it open.

    A handle is not thread-safe; ActiveGraph's ``Graph`` serializes its own
    appends. Use one handle per writer.
    """

    def __init__(
        self,
        target: Any,
        namespace: Optional[str] = None,
        database: Optional[str] = None,
        run_id: Optional[str] = None,
        *,
        username: Optional[str] = None,
        password: Optional[str] = None,
        ensure_schema: bool = True,
        page_size: int = 1000,
    ) -> None:
        if not run_id:
            raise TypeError(
                "SurrealEventStore requires a run_id, for example "
                "SurrealEventStore('ws://127.0.0.1:8000/rpc', 'app', 'events', run_id='run_1')."
            )
        if page_size < 1:
            raise ValueError("page_size must be at least 1")
        self.run_id = run_id
        self._page_size = page_size
        self._conn = Connection(
            target, namespace=namespace, database=database, username=username, password=password
        )
        try:
            if ensure_schema:
                _apply_schema(self._conn)
            self._expected_head, self._expected_last, self._expected_count = self._read_head()
        except BaseException:
            self._conn.close()
            raise

    def __repr__(self) -> str:
        return f"SurrealEventStore(run_id={self.run_id!r})"

    # ---------- EventStore protocol ----------

    def append(self, event: Event) -> None:
        row = encode_event(event)
        self._precheck_head()
        seq = self._expected_last + 1
        content = {
            "run_id": self.run_id,
            "seq": seq,
            "event_id": row["id"],
            "type": row["type"],
            "actor": row["actor"],
            "payload": row["payload"],
            "frame_id": row["frame_id"],
            "caused_by": row["caused_by"],
            "timestamp": row["timestamp"],
        }
        try:
            self._conn.query(_APPEND, {**self._head_vars(), "event": content})
        except SurrealQueryError as exc:
            if _EVENT_ID_INDEX in exc.message:
                raise self._duplicate_error(row["id"]) from exc
            if _is_head_conflict(exc):
                raise self._concurrent_error() from exc
            raise
        self._expected_head = seq
        self._expected_last = seq
        self._expected_count += 1

    def iter_events(
        self,
        after: Optional[str] = None,
        until: Optional[str] = None,
    ) -> Iterator[Event]:
        after_seq = self._seq_of(after) if after is not None else 0
        until_seq = self._seq_of(until) if until is not None else None
        while True:
            rows = self._conn.query(
                _PAGE,
                {
                    "run_id": self.run_id,
                    "after_seq": after_seq,
                    "until_seq": until_seq,
                    "limit": self._page_size,
                },
            )[0]
            for row in rows:
                yield _row_to_event(row)
            if len(rows) < self._page_size:
                return
            after_seq = int(rows[-1]["seq"])

    def get_event(self, event_id: str) -> Optional[Event]:
        rows = self._conn.query(
            "SELECT * FROM ag_event WHERE run_id = $run_id AND event_id = $event_id LIMIT 1;",
            {"run_id": self.run_id, "event_id": event_id},
        )[0]
        return _row_to_event(rows[0]) if rows else None

    def count(self) -> int:
        rows = self._conn.query(
            "SELECT count() AS n FROM ag_event WHERE run_id = $run_id GROUP ALL;",
            {"run_id": self.run_id},
        )[0]
        return int(rows[0]["n"]) if rows else 0

    def truncate_after(self, event_id: str) -> None:
        """Delete every event after ``event_id`` in one transaction.

        Raises ``EventNotFoundError`` for an unknown id and
        ``ConcurrentWriterError`` if the run head moved since this handle last
        observed it. Either way nothing is deleted.
        """
        self._precheck_head()
        try:
            results = self._conn.query(_TRUNCATE, {**self._head_vars(), "event_id": event_id})
        except SurrealQueryError as exc:
            if EVENT_MISSING in exc.message:
                raise _event_not_found(event_id, self.run_id) from exc
            if _is_head_conflict(exc):
                raise self._concurrent_error() from exc
            raise
        outcome = tagged_result(results, "ag_truncate")
        self._expected_head = int(outcome["head_seq"])
        self._expected_count = int(outcome["event_count"])

    def close(self) -> None:
        self._conn.close()

    # ---------- run metadata (same surface as the SQLite/Postgres stores) ----------

    def get_run(self) -> Optional[RunRecord]:
        row = self._conn.query(
            "SELECT * FROM ONLY $run_record;", {"run_record": _run_record(self.run_id)}
        )[0]
        return _row_to_run(row) if row else None

    def upsert_run(
        self,
        *,
        parent_run_id: Optional[str] = None,
        forked_at_event_id: Optional[str] = None,
        label: Optional[str] = None,
        created_at: str,
        goal: Optional[str] = None,
        frame_id: Optional[str] = None,
    ) -> None:
        """Insert or update this run's row. ``None`` never clears a stored
        value and ``created_at`` is only set on insert, as in the reference
        stores."""
        self._conn.query(
            _UPSERT_RUN,
            {
                "run_record": _run_record(self.run_id),
                "run_id": self.run_id,
                "parent_run_id": parent_run_id,
                "forked_at_event_id": forked_at_event_id,
                "label": label,
                "created_at": created_at,
                "goal": goal,
                "frame_id": frame_id,
            },
        )

    # ---------- snapshot sidecar (same surface as the SQLite store) ----------

    def put_snapshot(self, state_hash: str, blob: str, *, created_at: str) -> None:
        """Store a snapshot blob keyed by its state hash (idempotent)."""
        self._conn.query(
            "UPSERT $record CONTENT { state_hash: $state_hash, blob: $blob, created_at: $created_at };",
            {
                "record": _snapshot_record(state_hash),
                "state_hash": state_hash,
                "blob": blob,
                "created_at": created_at,
            },
        )

    def get_snapshot(self, state_hash: str) -> Optional[str]:
        """The snapshot blob for ``state_hash``, or None."""
        row = self._conn.query(
            "SELECT * FROM ONLY $record;", {"record": _snapshot_record(state_hash)}
        )[0]
        return row["blob"] if row else None

    # ---------- database-level helpers ----------

    @classmethod
    def list_runs(cls, target: Any, namespace: Optional[str] = None,
                  database: Optional[str] = None, **auth: Any) -> list[RunRecord]:
        """Every registered run (``upsert_run``/``fork_run``), oldest first."""
        with _scoped(target, namespace, database, auth) as conn:
            rows = conn.query("SELECT * FROM ag_run ORDER BY created_at;")[0]
        return [_row_to_run(row) for row in rows]

    @classmethod
    def most_recent_run_id(cls, target: Any, namespace: Optional[str] = None,
                           database: Optional[str] = None, **auth: Any) -> Optional[str]:
        """The registered run appended to most recently; runs without events
        follow, newest ``created_at`` first (the reference stores' order)."""
        with _scoped(target, namespace, database, auth) as conn:
            runs, heads = conn.query(
                "SELECT run_id, created_at FROM ag_run;"
                "SELECT run_id, appended_at FROM ag_run_head WHERE event_count > 0;"
            )
        appended = {row["run_id"]: row.get("appended_at") for row in heads}
        if not runs:
            return None
        with_events = [r for r in runs if appended.get(r["run_id"]) is not None]
        if with_events:
            return max(with_events, key=lambda r: appended[r["run_id"]])["run_id"]
        return max(runs, key=lambda r: r["created_at"])["run_id"]

    @classmethod
    def fork_run(
        cls,
        target: Any,
        namespace: Optional[str] = None,
        database: Optional[str] = None,
        *,
        parent_run_id: str,
        new_run_id: str,
        at_event_id: str,
        label: Optional[str],
        created_at: str,
        **auth: Any,
    ) -> int:
        """Copy ``parent_run_id``'s events up to and including ``at_event_id``
        into a new run, in one transaction. Returns the number copied."""
        with _scoped(target, namespace, database, auth) as conn:
            try:
                results = conn.query(
                    _FORK,
                    {
                        "parent_run_id": parent_run_id,
                        "new_run_id": new_run_id,
                        "at_event_id": at_event_id,
                        "label": label,
                        "created_at": created_at,
                        "parent_run_record": _run_record(parent_run_id),
                        "new_run_record": _run_record(new_run_id),
                        "new_head_record": _head_record(new_run_id),
                    },
                )
            except SurrealQueryError as exc:
                if EVENT_MISSING in exc.message:
                    raise _event_not_found(at_event_id, parent_run_id, operation="fork") from exc
                if RUN_EXISTS in exc.message:
                    raise ValueError(f"run {new_run_id!r} already exists") from exc
                raise
        return int(tagged_result(results, "ag_fork")["copied"])

    # ---------- internals ----------

    def _head_vars(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "head_record": _head_record(self.run_id),
            "expected_head": self._expected_head,
            "expected_last": self._expected_last,
            "expected_count": self._expected_count,
        }

    def _read_head(self) -> tuple[Optional[int], int, int]:
        row = self._conn.query(
            "SELECT * FROM ONLY $head_record;", {"head_record": _head_record(self.run_id)}
        )[0]
        if not row:
            return None, 0, 0
        head = row.get("head_seq")
        return (
            None if head is None else int(head),
            int(row.get("last_seq") or 0),
            int(row.get("event_count") or 0),
        )

    def _precheck_head(self) -> None:
        """Fail before opening a transaction when the head already moved.

        The transaction repeats this check, so skipping it never lets a stale
        writer through; it only avoids a doomed write.
        """
        head, last, _ = self._read_head()
        if head != self._expected_head or last != self._expected_last:
            raise self._concurrent_error()

    def _concurrent_error(self) -> ConcurrentWriterError:
        try:
            actual_head, _, actual_count = self._read_head()
        except Exception:  # the conflict is what matters; report what we can
            actual_head, actual_count = None, -1
        return ConcurrentWriterError(
            run_id=self.run_id,
            expected_head=_head_token(self._expected_head),
            actual_head=_head_token(actual_head),
            expected_count=self._expected_count,
            actual_count=actual_count,
            driver=DRIVER,
        )

    def _duplicate_error(self, event_id: str) -> DuplicateEventError:
        return DuplicateEventError(
            f"duplicate event id {event_id!r} in run {self.run_id!r}",
            what_failed=(
                f"SurrealDB refused event {event_id!r} because that logical id "
                f"already exists in run {self.run_id!r}."
            ),
            why=(
                "Event ids are unique within a run. Reusing one would make "
                "causal references and replay lookup ambiguous."
            ),
            how_to_fix=(
                "Use the graph/runtime ID generator and do not retry an "
                "already accepted event. If another writer owns this run, "
                "reload it and coordinate a single writer."
            ),
            context={"event_id": event_id, "run_id": self.run_id, "driver": DRIVER},
        )

    def _seq_of(self, event_id: str) -> int:
        rows = self._conn.query(
            "SELECT VALUE seq FROM ag_event WHERE run_id = $run_id AND event_id = $event_id;",
            {"run_id": self.run_id, "event_id": event_id},
        )[0]
        if not rows:
            raise _event_not_found(event_id, self.run_id)
        return int(rows[0])


def open_surreal_store(
    url: str,
    run_id: str,
    *,
    namespace: Optional[str] = None,
    database: Optional[str] = None,
    username: Optional[str] = None,
    password: Optional[str] = None,
) -> SurrealEventStore:
    """Open a :class:`SurrealEventStore` from a URL.

    ActiveGraph 1.12's ``open_store`` only dispatches ``sqlite`` and
    ``postgres`` URLs and has no plug-in registry, so this is the URL entry
    point for SurrealDB. Accepted forms::

        ws://127.0.0.1:8000/rpc?ns=app&db=events
        surrealdb+wss://db.example.com/rpc?ns=app&db=events
        http://127.0.0.1:8000?ns=app&db=events
        mem://?ns=app&db=events
        surrealkv:///var/lib/app/events.skv?ns=app&db=events

    Keyword arguments override the ``ns``/``db`` URL parameters. Credentials
    are keyword-only and are never read from the URL.
    """
    return SurrealEventStore(
        url,
        namespace=namespace,
        database=database,
        run_id=run_id,
        username=username,
        password=password,
    )


class _scoped:
    """Context manager: a Connection for a classmethod, schema applied."""

    def __init__(self, target: Any, namespace: Optional[str], database: Optional[str],
                 auth: dict[str, Any]) -> None:
        unknown = set(auth) - {"username", "password"}
        if unknown:
            raise TypeError(f"unexpected keyword arguments: {sorted(unknown)}")
        self._conn = Connection(target, namespace=namespace, database=database, **auth)

    def __enter__(self) -> Connection:
        try:
            _apply_schema(self._conn)
        except BaseException:
            self._conn.close()
            raise
        return self._conn

    def __exit__(self, *exc: Any) -> None:
        self._conn.close()


def _is_head_conflict(exc: SurrealQueryError) -> bool:
    return (
        HEAD_MOVED in exc.message
        or _EVENT_SEQ_INDEX in exc.message
        or exc.kind == "TransactionConflict"
        or "transaction conflict" in exc.message.lower()
        or "read or write conflict" in exc.message.lower()
    )


def _event_not_found(event_id: str, run_id: str, *, operation: str = "lookup") -> EventNotFoundError:
    return EventNotFoundError(
        f"event {event_id!r} not found in run {run_id!r}",
        what_failed=f"The SurrealDB store has no event with id {event_id!r} in run {run_id!r}.",
        why=(
            "Event ids are the framework's addressing primitive. The store "
            "refuses to guess a position for an unknown id."
        ),
        how_to_fix=(
            "Check the id against the run's events (store.iter_events()). Common "
            "causes: a typo, an id from another run, or a run truncated earlier."
        ),
        context={"event_id": event_id, "run_id": run_id, "operation": operation, "driver": DRIVER},
    )


def _row_to_event(row: dict[str, Any]) -> Event:
    return decode_event(
        {
            "id": row["event_id"],
            "type": row["type"],
            "payload": row["payload"],
            "actor": row.get("actor"),
            "frame_id": row.get("frame_id"),
            "caused_by": row.get("caused_by"),
            "timestamp": row["timestamp"],
        }
    )


def _row_to_run(row: dict[str, Any]) -> RunRecord:
    return RunRecord(
        run_id=row["run_id"],
        parent_run_id=row.get("parent_run_id"),
        forked_at_event_id=row.get("forked_at_event_id"),
        label=row.get("label"),
        created_at=row["created_at"],
        goal=row.get("goal"),
        frame_id=row.get("frame_id"),
    )


def _head_token(seq: Optional[int]) -> Optional[str]:
    return None if seq is None else str(seq)


def _run_record(run_id: str) -> Any:
    from surrealdb import RecordID

    return RecordID("ag_run", run_id)


def _head_record(run_id: str) -> Any:
    from surrealdb import RecordID

    return RecordID("ag_run_head", run_id)


def _snapshot_record(state_hash: str) -> Any:
    from surrealdb import RecordID

    return RecordID("ag_snapshot", state_hash)
