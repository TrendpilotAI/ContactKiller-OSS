"""Single-writer enforcement: ConcurrentWriterError, its context, and atomicity."""

from __future__ import annotations

import threading

import pytest
from activegraph.store.errors import ConcurrentWriterError

from activegraph_surrealdb import SurrealEventStore, SurrealQueryError
from activegraph_surrealdb._client import results_or_raise
from activegraph_surrealdb.event_store import HEAD_MOVED
from surreal_support import Session, make_event


def _ids(store) -> list[str]:
    return [event.id for event in store.iter_events()]


def _disable_precheck(monkeypatch: pytest.MonkeyPatch, store) -> None:
    """Leave only the in-transaction compare-and-swap between the writer and
    the database."""
    monkeypatch.setattr(store, "_precheck_head", lambda: None)


def _assert_context(
    error: ConcurrentWriterError,
    *,
    run_id: str,
    expected_head: str | None,
    actual_head: str | None,
    expected_count: int,
    actual_count: int,
) -> None:
    assert error.context == {
        "run_id": run_id,
        "expected_head": expected_head,
        "actual_head": actual_head,
        "expected_count": expected_count,
        "actual_count": actual_count,
        "driver": "surrealdb",
    }


def test_second_writer_between_construction_and_first_append(session: Session) -> None:
    stale = session.event_store("run_cw_a")
    other = session.event_store("run_cw_a")
    other.append(make_event("evt_other"))

    with pytest.raises(ConcurrentWriterError) as caught:
        stale.append(make_event("evt_stale"))

    _assert_context(
        caught.value,
        run_id="run_cw_a",
        expected_head=None,
        actual_head="1",
        expected_count=0,
        actual_count=1,
    )
    assert _ids(other) == ["evt_other"]
    # The handle stays stale: a retry is refused too, never silently adopted.
    with pytest.raises(ConcurrentWriterError):
        stale.append(make_event("evt_stale_retry"))
    assert _ids(other) == ["evt_other"]


def test_in_transaction_compare_and_swap(session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    stale = session.event_store("run_cw_b")
    other = session.event_store("run_cw_b")
    other.append(make_event("evt_0"))
    other.append(make_event("evt_1"))
    _disable_precheck(monkeypatch, stale)

    with pytest.raises(ConcurrentWriterError) as caught:
        stale.append(make_event("evt_stale"))

    cause = caught.value.__cause__
    assert isinstance(cause, SurrealQueryError)
    assert HEAD_MOVED in cause.message
    _assert_context(
        caught.value,
        run_id="run_cw_b",
        expected_head=None,
        actual_head="2",
        expected_count=0,
        actual_count=2,
    )
    assert _ids(other) == ["evt_0", "evt_1"]
    assert other.count() == 2


@pytest.mark.parametrize("precheck", [True, False], ids=["precheck", "in-transaction"])
def test_truncate_racing_an_append_is_refused(
    session: Session, monkeypatch: pytest.MonkeyPatch, precheck: bool
) -> None:
    seed = session.event_store("run_cw_c")
    for i in range(3):
        seed.append(make_event(f"evt_{i}"))
    truncator = session.event_store("run_cw_c")
    appender = session.event_store("run_cw_c")
    if not precheck:
        _disable_precheck(monkeypatch, truncator)

    appender.append(make_event("evt_3"))
    with pytest.raises(ConcurrentWriterError) as caught:
        truncator.truncate_after("evt_0")

    _assert_context(
        caught.value,
        run_id="run_cw_c",
        expected_head="3",
        actual_head="4",
        expected_count=3,
        actual_count=4,
    )
    # Atomic: the refused truncation deleted nothing.
    assert _ids(appender) == ["evt_0", "evt_1", "evt_2", "evt_3"]


@pytest.mark.parametrize("precheck", [True, False], ids=["precheck", "in-transaction"])
def test_append_racing_a_truncate_is_refused(
    session: Session, monkeypatch: pytest.MonkeyPatch, precheck: bool
) -> None:
    seed = session.event_store("run_cw_d")
    for i in range(3):
        seed.append(make_event(f"evt_{i}"))
    truncator = session.event_store("run_cw_d")
    appender = session.event_store("run_cw_d")
    if not precheck:
        _disable_precheck(monkeypatch, appender)

    truncator.truncate_after("evt_0")
    with pytest.raises(ConcurrentWriterError) as caught:
        appender.append(make_event("evt_3"))

    _assert_context(
        caught.value,
        run_id="run_cw_d",
        expected_head="3",
        actual_head="1",
        expected_count=3,
        actual_count=1,
    )
    assert _ids(truncator) == ["evt_0"]
    # The truncating handle tracked its own write and can keep appending.
    truncator.append(make_event("evt_after"))
    assert _ids(truncator) == ["evt_0", "evt_after"]


def test_truncate_then_append_elsewhere_still_moves_the_head(
    session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A run can return to the same head seq (append then truncate back).
    The never-decreasing last_seq makes that a head change anyway."""
    seed = session.event_store("run_cw_e")
    for i in range(3):
        seed.append(make_event(f"evt_{i}"))
    stale = session.event_store("run_cw_e")
    other = session.event_store("run_cw_e")
    other.append(make_event("evt_3"))
    other.truncate_after("evt_2")
    _disable_precheck(monkeypatch, stale)

    with pytest.raises(ConcurrentWriterError) as caught:
        stale.append(make_event("evt_stale"))

    _assert_context(
        caught.value,
        run_id="run_cw_e",
        expected_head="3",
        actual_head="3",
        expected_count=3,
        actual_count=3,
    )
    assert _ids(other) == ["evt_0", "evt_1", "evt_2"]


def test_racing_writers_exactly_one_wins(session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    """Writers constructed at the same head race their first append. On a
    server each writer has its own connection, so losers fail either the
    in-transaction check or the commit (TransactionConflict)."""
    writers = 8
    clients = (
        [session.new_client() for _ in range(writers)]
        if session.target.kind == "server"
        else [session.client] * writers
    )
    stores = [SurrealEventStore(client, run_id="run_cw_race") for client in clients]
    for store in stores:
        _disable_precheck(monkeypatch, store)
    barrier = threading.Barrier(writers)
    outcomes: list[object] = [None] * writers

    def attempt(index: int) -> None:
        barrier.wait()
        try:
            stores[index].append(make_event(f"evt_writer_{index}"))
            outcomes[index] = "ok"
        except Exception as exc:  # recorded and asserted below
            outcomes[index] = exc

    threads = [threading.Thread(target=attempt, args=(i,)) for i in range(writers)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    winners = [i for i, outcome in enumerate(outcomes) if outcome == "ok"]
    losers = [outcome for outcome in outcomes if outcome != "ok"]
    assert len(winners) == 1
    assert all(isinstance(outcome, ConcurrentWriterError) for outcome in losers), losers
    assert all(outcome.context["driver"] == "surrealdb" for outcome in losers)
    assert _ids(stores[0]) == [f"evt_writer_{winners[0]}"]


def test_commit_transaction_conflict_maps_to_concurrent_writer(
    session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Deterministic version of the race above: the database reports a commit
    TransactionConflict (the exact shape a SurrealDB 3 server returns)."""
    store = session.event_store("run_cw_conflict")
    conflict = {
        "result": [
            {"status": "OK", "result": None},
            {
                "status": "ERR",
                "kind": "Query",
                "details": {"kind": "NotExecuted"},
                "result": "The query was not executed due to a failed transaction",
            },
            {
                "status": "ERR",
                "kind": "Query",
                "details": {"kind": "TransactionConflict"},
                "result": (
                    "Cannot COMMIT: Transaction conflict: Write conflict, retry the "
                    "transaction. This transaction can be retried"
                ),
            },
        ]
    }
    real_query = store._conn.query

    def conflicting_query(surql, variables=None):
        if "CREATE ag_event" in surql:
            return results_or_raise(conflict)
        return real_query(surql, variables)

    monkeypatch.setattr(store._conn, "query", conflicting_query)
    with pytest.raises(ConcurrentWriterError) as caught:
        store.append(make_event("evt_conflict"))

    cause = caught.value.__cause__
    assert isinstance(cause, SurrealQueryError)
    assert cause.kind == "TransactionConflict"
    _assert_context(
        caught.value,
        run_id="run_cw_conflict",
        expected_head=None,
        actual_head=None,
        expected_count=0,
        actual_count=0,
    )
    assert store.count() == 0
