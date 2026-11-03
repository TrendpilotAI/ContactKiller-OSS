"""Run metadata, snapshots and fork: the helpers the reference stores expose."""

from __future__ import annotations

import pytest
from activegraph.store.errors import EventNotFoundError

from activegraph_surrealdb import SurrealEventStore
from surreal_support import Session, make_event


def test_upsert_run_never_clears_and_keeps_created_at(session: Session) -> None:
    store = session.event_store("run_meta")
    assert store.get_run() is None
    store.upsert_run(created_at="2026-01-01T00:00:00Z", label="first", goal="g1")
    store.upsert_run(created_at="2026-02-02T00:00:00Z", frame_id="frame_1")

    record = store.get_run()
    assert record is not None
    assert (record.created_at, record.label, record.goal, record.frame_id) == (
        "2026-01-01T00:00:00Z",
        "first",
        "g1",
        "frame_1",
    )


def test_list_runs_and_most_recent(session: Session) -> None:
    client = session.client
    assert SurrealEventStore.most_recent_run_id(client) is None
    older = session.event_store("run_older")
    newer = session.event_store("run_newer")
    idle = session.event_store("run_idle")
    older.upsert_run(created_at="2026-01-01T00:00:00Z")
    newer.upsert_run(created_at="2026-01-02T00:00:00Z")
    idle.upsert_run(created_at="2026-01-03T00:00:00Z")

    # No events anywhere: newest created_at wins.
    assert SurrealEventStore.most_recent_run_id(client) == "run_idle"
    newer.append(make_event("evt_n"))
    older.append(make_event("evt_o"))
    # Runs with events come first, most recently appended to.
    assert SurrealEventStore.most_recent_run_id(client) == "run_older"
    assert [r.run_id for r in SurrealEventStore.list_runs(client)] == [
        "run_older",
        "run_newer",
        "run_idle",
    ]


def test_catalog_status_is_read_only_and_detects_orphans(session: Session) -> None:
    # Before any store touches the database, catalog_status returns (False, 0)
    # without applying the schema.
    assert SurrealEventStore.catalog_status(session.client, "run_cat") == (False, 0)
    info = session.client.query_raw("INFO FOR DB;", {})["result"][0]["result"]
    assert "ag_run" not in info.get("tables", {})

    store = session.event_store("run_cat")
    # Events without an ag_run row report (False, event_count).
    store.append(make_event("evt_orphan"))
    assert SurrealEventStore.catalog_status(session.client, "run_cat") == (False, 1)

    store.upsert_run(created_at="2026-01-01T00:00:00Z")
    assert SurrealEventStore.catalog_status(session.client, "run_cat") == (True, 1)


def test_most_recent_run_id_orders_chronologically_across_unequal_lengths_and_truncation(
    session: Session,
) -> None:
    longer_older = session.event_store("run_longer_older")
    shorter_newer = session.event_store("run_shorter_newer")
    longer_older.upsert_run(created_at="2026-01-01T00:00:00Z")
    shorter_newer.upsert_run(created_at="2026-01-02T00:00:00Z")

    for i in range(5):
        longer_older.append(make_event(f"evt_long_{i}"))
    # A newer run with fewer events (head_seq=1 vs head_seq=5) still wins because
    # its latest event was appended more recently.
    shorter_newer.append(make_event("evt_short_0"))
    assert SurrealEventStore.most_recent_run_id(session.client) == "run_shorter_newer"

    # Appending to longer_older makes it most recent, and truncating that tail
    # restores the earlier appended_at so shorter_newer becomes most recent again.
    longer_older.append(make_event("evt_long_5"))
    assert SurrealEventStore.most_recent_run_id(session.client) == "run_longer_older"
    longer_older.truncate_after("evt_long_4")
    assert SurrealEventStore.most_recent_run_id(session.client) == "run_shorter_newer"


def test_fork_run_requires_registered_parent_and_preserves_seq_after_truncate(session: Session) -> None:
    unregistered = session.event_store("run_unregistered_parent")
    unregistered.append(make_event("evt_0"))
    with pytest.raises(EventNotFoundError):
        SurrealEventStore.fork_run(
            session.client,
            parent_run_id="run_unregistered_parent",
            new_run_id="run_orphan_child",
            at_event_id="evt_0",
            label=None,
            created_at="2026-01-02T00:00:00Z",
        )

    parent = session.event_store("run_truncated_parent")
    parent.upsert_run(created_at="2026-01-01T00:00:00Z")
    parent.append(make_event("evt_0"))
    parent.append(make_event("evt_1"))
    parent.truncate_after("evt_0")
    parent.append(make_event("evt_2"))  # seq 3 (non-contiguous after truncate)

    copied = SurrealEventStore.fork_run(
        session.client,
        parent_run_id="run_truncated_parent",
        new_run_id="run_truncated_child",
        at_event_id="evt_2",
        label="after-truncate",
        created_at="2026-01-03T00:00:00Z",
    )
    assert copied == 2
    child = session.event_store("run_truncated_child")
    assert [e.id for e in child.iter_events()] == ["evt_0", "evt_2"]
    child.append(make_event("evt_3"))
    assert [e.id for e in child.iter_events()] == ["evt_0", "evt_2", "evt_3"]


def test_fork_run_copies_the_prefix_with_lineage(session: Session) -> None:
    parent = session.event_store("run_parent")
    parent.upsert_run(created_at="2026-01-01T00:00:00Z", goal="parent goal")
    for i in range(4):
        parent.append(make_event(f"evt_{i}"))

    copied = SurrealEventStore.fork_run(
        session.client,
        parent_run_id="run_parent",
        new_run_id="run_child",
        at_event_id="evt_1",
        label="trial",
        created_at="2026-01-05T00:00:00Z",
    )

    assert copied == 2
    child = session.event_store("run_child")
    assert [e.id for e in child.iter_events()] == ["evt_0", "evt_1"]
    record = child.get_run()
    assert (record.parent_run_id, record.forked_at_event_id, record.label, record.goal) == (
        "run_parent",
        "evt_1",
        "trial",
        "parent goal",
    )
    # The fork is an independent run at its own head.
    child.append(make_event("evt_child"))
    assert parent.count() == 4

    with pytest.raises(EventNotFoundError):
        SurrealEventStore.fork_run(
            session.client, parent_run_id="run_parent", new_run_id="run_other",
            at_event_id="evt_missing", label=None, created_at="2026-01-06T00:00:00Z",
        )
    with pytest.raises(ValueError, match="already exists"):
        SurrealEventStore.fork_run(
            session.client, parent_run_id="run_parent", new_run_id="run_child",
            at_event_id="evt_0", label=None, created_at="2026-01-06T00:00:00Z",
        )
    assert [e.id for e in child.iter_events()] == ["evt_0", "evt_1", "evt_child"]


def test_snapshots_are_idempotent_by_hash(session: Session) -> None:
    store = session.event_store("run_snap")
    assert store.get_snapshot("sha256:abc") is None
    store.put_snapshot("sha256:abc", '{"objects": []}', created_at="2026-01-01T00:00:00Z")
    store.put_snapshot("sha256:abc", '{"objects": []}', created_at="2026-01-02T00:00:00Z")
    assert store.get_snapshot("sha256:abc") == '{"objects": []}'
