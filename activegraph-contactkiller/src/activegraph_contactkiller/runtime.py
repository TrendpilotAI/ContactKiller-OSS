"""Runtime construction for ContactKiller.

The ActiveGraph event store is the durable authority for operations,
manifests, approvals, and domain changes. The in-memory or external graph is
only a replayable projection of that event sequence. Store URLs may use
``sqlite:///`` for local single-writer operation or ``postgres://`` /
``postgresql://`` for a shared event store. Credentials in a PostgreSQL URL
are runtime configuration and must never be copied into an event payload.
"""

from __future__ import annotations

from datetime import datetime, timezone

from activegraph import Graph, Runtime
from activegraph.store import open_store, parse_store_url

from . import pack


class ContactKillerRuntimeError(RuntimeError):
    """Base error for explicit ContactKiller runtime lifecycle failures."""


class RunAlreadyExistsError(ContactKillerRuntimeError):
    """A create-only call targeted an existing event-store run."""


class RunNotFoundError(ContactKillerRuntimeError):
    """A replay-only call targeted a run with no metadata or events."""


class InconsistentRunStoreError(ContactKillerRuntimeError):
    """Events exist for a run whose required run metadata is missing."""


def create_runtime(event_store_url: str, *, run_id: str) -> Runtime:
    """Create a new run, failing clearly if ``run_id`` already exists.

    Use :func:`open_runtime` for the canonical long-lived process contract
    where first boot creates the run and subsequent boots replay it.
    """

    _validate_runtime_inputs(event_store_url, run_id)
    store = open_store(event_store_url, run_id=run_id)
    existing = _inspect_run(store, run_id=run_id)
    if existing:
        store.close()
        raise RunAlreadyExistsError(
            f"ActiveGraph run {run_id!r} already exists; use open_runtime() "
            "to replay and continue it"
        )
    return _create_with_open_store(store, run_id=run_id)


def open_runtime(event_store_url: str, *, run_id: str) -> Runtime:
    """Create ``run_id`` on first boot or replay it on subsequent boots.

    The decision is based on durable run metadata. Driver errors and event-log
    corruption are not converted into a fresh run; they propagate so an
    operator cannot accidentally replace a damaged canonical history.
    """

    _validate_runtime_inputs(event_store_url, run_id)
    store = open_store(event_store_url, run_id=run_id)
    existing = _inspect_run(store, run_id=run_id)
    if existing:
        store.close()
        return _replay_existing(event_store_url, run_id=run_id)
    return _create_with_open_store(store, run_id=run_id)


def replay_runtime(event_store_url: str, *, run_id: str) -> Runtime:
    """Replay an existing run; never create a missing run implicitly."""

    _validate_runtime_inputs(event_store_url, run_id)
    store = open_store(event_store_url, run_id=run_id)
    existing = _inspect_run(store, run_id=run_id)
    store.close()
    if not existing:
        raise RunNotFoundError(
            f"ActiveGraph run {run_id!r} does not exist; use open_runtime() "
            "to create it on first boot"
        )
    return _replay_existing(event_store_url, run_id=run_id)


def _replay_existing(event_store_url: str, *, run_id: str) -> Runtime:
    runtime = Runtime.load(event_store_url, run_id=run_id)
    runtime.load_pack(pack)
    return runtime


def _create_with_open_store(store, *, run_id: str) -> Runtime:
    if hasattr(store, "upsert_run"):
        store.upsert_run(created_at=datetime.now(timezone.utc).isoformat())
    runtime = Runtime(Graph(run_id=run_id), store=store)
    runtime.load_pack(pack)
    return runtime


def _inspect_run(store, *, run_id: str) -> bool:
    """Return run existence, rejecting orphaned events as corruption."""

    try:
        if store.get_run() is not None:
            return True
        event_count = store.count()
    except Exception:
        store.close()
        raise
    if event_count:
        store.close()
        raise InconsistentRunStoreError(
            f"ActiveGraph run {run_id!r} has {event_count} event(s) but no run "
            "metadata; refusing to create over a potentially corrupted log"
        )
    return False


def _validate_runtime_inputs(event_store_url: str, run_id: str) -> None:
    parse_store_url(event_store_url)
    if not run_id.strip():
        raise ValueError("run_id must be non-empty")


__all__ = [
    "ContactKillerRuntimeError",
    "InconsistentRunStoreError",
    "RunAlreadyExistsError",
    "RunNotFoundError",
    "create_runtime",
    "open_runtime",
    "replay_runtime",
]
