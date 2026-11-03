from __future__ import annotations

import pytest
from activegraph import Graph, Runtime
from activegraph.packs import PackSchemaViolation
from activegraph.store import ConcurrentWriterError, open_store
from activegraph_contactkiller import pack
from activegraph_contactkiller.models import sha256_text
from activegraph_contactkiller.runtime import (
    InconsistentRunStoreError,
    RunAlreadyExistsError,
    RunNotFoundError,
    create_runtime,
    open_runtime,
    replay_runtime,
)


def _close(*runtimes: Runtime) -> None:
    for runtime in runtimes:
        runtime.graph.store.close()


def _event_count(store_url: str, run_id: str) -> int:
    store = open_store(store_url, run_id=run_id)
    try:
        return store.count()
    finally:
        store.close()


def _person(runtime: Runtime, key: str):
    return runtime.graph.add_object(
        "person", {"person_key": key, "display_name": key}
    )


def _projection(
    runtime,
) -> tuple[list[tuple[str, str, dict]], list[tuple[str, str, str]]]:
    objects = sorted(
        (item.id, item.type, item.data) for item in runtime.graph.all_objects()
    )
    relations = sorted(
        (item.source, item.target, item.type) for item in runtime.graph.all_relations()
    )
    return objects, relations


def test_event_log_replays_the_same_graph_projection(event_store) -> None:
    store_url = event_store.url
    runtime = create_runtime(store_url, run_id="run_replay")
    runtime.graph.add_object(
        "manifest",
        {
            "manifest_key": "contacts:replay:v1",
            "name": "Replay contract",
            "version": "1.0.0",
            "state": "active",
            "content_uri": "file:///manifests/replay-v1.json",
            "content_sha256": "c" * 64,
            "created_by": "test",
        },
    )
    runtime.run_until_idle()
    expected = _projection(runtime)
    runtime.save_state()

    replayed = replay_runtime(store_url, run_id="run_replay")

    assert _projection(replayed) == expected
    assert any(event.type == "object.created" for event in replayed.graph.events)
    _close(runtime, replayed)


def test_identity_approval_survives_replay_and_can_be_granted(event_store) -> None:
    store_url = event_store.url
    runtime = create_runtime(store_url, run_id="run_pending_replay")
    people = [
        runtime.graph.add_object(
            "person",
            {
                "person_key": f"person:pending:{index}",
                "display_name": "Sentinel Friend",
            },
        )
        for index in range(2)
    ]
    runtime.run_until_idle()
    email = "sentinel@example.com"
    for index, person in enumerate(people):
        runtime.graph.add_object(
            "identity_observation",
            {
                "observation_key": f"pending-email:{index}",
                "source_record_key": f"pending-source:{index}",
                "person_id": person.id,
                "kind": "email",
                "normalized_value": email,
                "value_sha256": sha256_text(email),
                "observed_at": f"2026-08-30T14:0{index}:00Z",
            },
        )
        runtime.run_until_idle()

    original = runtime.pending_approvals()
    assert len(original) == 1
    approval_id = original[0].id
    runtime.save_state()

    replayed = replay_runtime(store_url, run_id="run_pending_replay")
    pending = replayed.pending_approvals()
    assert [item.id for item in pending] == [approval_id]
    assert not any(
        item.type == "identity_resolution" for item in replayed.graph.all_objects()
    )

    resolution_id = replayed.approve(approval_id, approved_by="test-reviewer")
    resolution = replayed.graph.get_object(resolution_id)
    assert resolution is not None
    assert resolution.type == "identity_resolution"
    assert replayed.pending_approvals() == []
    _close(runtime, replayed)


def test_create_runtime_fails_clearly_when_run_already_exists(event_store) -> None:
    store_url = event_store.url
    runtime = create_runtime(store_url, run_id="canonical_contacts")

    with pytest.raises(RunAlreadyExistsError, match="use open_runtime"):
        create_runtime(store_url, run_id="canonical_contacts")
    _close(runtime)


def test_open_runtime_creates_then_replays_canonical_run(event_store) -> None:
    store_url = event_store.url
    first = open_runtime(store_url, run_id="canonical_contacts")
    person = first.graph.add_object(
        "person",
        {"person_key": "canonical:sentinel", "display_name": "Sentinel Friend"},
    )
    first.run_until_idle()
    first.save_state()

    reopened = open_runtime(store_url, run_id="canonical_contacts")

    restored = reopened.graph.get_object(person.id)
    assert restored is not None
    assert restored.data["person_key"] == "canonical:sentinel"
    _close(first, reopened)


def test_replay_runtime_does_not_create_a_missing_run(event_store) -> None:
    store_url = event_store.url

    with pytest.raises(RunNotFoundError, match="use open_runtime"):
        replay_runtime(store_url, run_id="missing_contacts")


def test_open_runtime_refuses_orphaned_events_instead_of_recreating(event_store) -> None:
    store_url = event_store.url
    runtime = create_runtime(store_url, run_id="canonical_contacts")
    runtime.graph.store.close()
    event_store.delete_run_metadata("canonical_contacts")

    with pytest.raises(InconsistentRunStoreError, match="refusing to create"):
        open_runtime(store_url, run_id="canonical_contacts")


def test_reopening_a_run_does_not_append_pack_loaded_events(event_store) -> None:
    store_url = event_store.url
    first = open_runtime(store_url, run_id="canonical_contacts")
    _person(first, "canonical:reopen")
    first.run_until_idle()
    first.save_state()
    _close(first)
    recorded = _event_count(store_url, "canonical_contacts")

    for reopen in (open_runtime, replay_runtime, open_runtime):
        runtime = reopen(store_url, run_id="canonical_contacts")
        assert [loaded.name for loaded in runtime.loaded_packs()] == ["contactkiller"]
        assert len(runtime.graph.events) == recorded
        _close(runtime)

    assert _event_count(store_url, "canonical_contacts") == recorded
    final = replay_runtime(store_url, run_id="canonical_contacts")
    assert [event.type for event in final.graph.events].count("pack.loaded") == 1
    _close(final)


def test_reopened_run_keeps_pack_validation_and_behaviors_active(event_store) -> None:
    store_url = event_store.url
    first = open_runtime(store_url, run_id="canonical_contacts")
    people = [_person(first, f"canonical:active:{index}") for index in range(2)]
    first.run_until_idle()
    first.save_state()
    _close(first)

    runtime = open_runtime(store_url, run_id="canonical_contacts")
    with pytest.raises(PackSchemaViolation):
        runtime.graph.add_object(
            "source_record",
            {
                "source_record_key": "mesh:123",
                "source_key": "mesh:example-workspace",
                "external_id": "123",
                "payload_uri": "file:///private/contactkiller/mesh/123.json",
                "payload_sha256": "a" * 64,
                "schema_version": "mesh-v2",
                "observed_at": "2026-08-30T12:00:00Z",
                "raw_payload": {"email": "must-not-enter-the-event-log@example.com"},
            },
        )

    email = "reopen@example.com"
    for index, person in enumerate(people):
        runtime.graph.add_object(
            "identity_observation",
            {
                "observation_key": f"reopen-email:{index}",
                "source_record_key": f"reopen-source:{index}",
                "person_id": person.id,
                "kind": "email",
                "normalized_value": email,
                "value_sha256": sha256_text(email),
                "observed_at": f"2026-08-30T15:0{index}:00Z",
            },
        )
        runtime.run_until_idle()
    assert len(runtime.pending_approvals()) == 1

    numbers = [int(event.id.removeprefix("evt_")) for event in runtime.graph.events]
    assert numbers == list(range(1, len(numbers) + 1))
    _close(runtime)


def test_second_open_of_a_run_does_not_fence_the_first_writer(event_store) -> None:
    store_url = event_store.url
    create_runtime(store_url, run_id="canonical_contacts").graph.store.close()

    first = replay_runtime(store_url, run_id="canonical_contacts")
    second = replay_runtime(store_url, run_id="canonical_contacts")
    _person(first, "canonical:first-writer")

    with pytest.raises(ConcurrentWriterError):
        _person(second, "canonical:second-writer")
    _close(first, second)

    recorded = replay_runtime(store_url, run_id="canonical_contacts")
    keys = [
        item.data["person_key"]
        for item in recorded.graph.all_objects()
        if item.type == "person"
    ]
    assert keys == ["canonical:first-writer"]
    _close(recorded)


def test_pack_missing_from_the_log_is_recorded_once_on_replay(event_store) -> None:
    store_url = event_store.url
    store = open_store(store_url, run_id="packless_contacts")
    store.upsert_run(created_at="2026-08-30T12:00:00+00:00")
    runtime = Runtime(Graph(run_id="packless_contacts"), store=store)
    _close(runtime)
    assert _event_count(store_url, "packless_contacts") == 0

    first = replay_runtime(store_url, run_id="packless_contacts")
    assert [event.type for event in first.graph.events] == ["pack.loaded"]
    _close(first)
    second = replay_runtime(store_url, run_id="packless_contacts")
    assert [event.type for event in second.graph.events] == ["pack.loaded"]
    _close(second)


def test_unfired_events_survive_reopen_and_fire_on_next_drain(event_store) -> None:
    """An event persisted after the last runtime.idle (before the process
    drained the queue) is requeued on reopen and fires its pack behavior
    once without duplicate pack.loaded events."""
    store_url = event_store.url
    first = open_runtime(store_url, run_id="canonical_unfired")
    people = [_person(first, f"canonical:unfired:{index}") for index in range(2)]
    first.run_until_idle()
    email = "unfired@example.com"
    first.graph.add_object(
        "identity_observation",
        {
            "observation_key": "unfired-email:0",
            "source_record_key": "unfired-source:0",
            "person_id": people[0].id,
            "kind": "email",
            "normalized_value": email,
            "value_sha256": sha256_text(email),
            "observed_at": "2026-08-30T16:00:00Z",
        },
    )
    first.run_until_idle()
    # Persist the second observation without calling run_until_idle():
    first.graph.add_object(
        "identity_observation",
        {
            "observation_key": "unfired-email:1",
            "source_record_key": "unfired-source:1",
            "person_id": people[1].id,
            "kind": "email",
            "normalized_value": email,
            "value_sha256": sha256_text(email),
            "observed_at": "2026-08-30T16:01:00Z",
        },
    )
    assert first.pending_approvals() == []
    first.save_state()
    _close(first)

    # Reopen without draining, then reopen again and drain:
    reopened_undrained = open_runtime(store_url, run_id="canonical_unfired")
    _close(reopened_undrained)

    reopened = open_runtime(store_url, run_id="canonical_unfired")
    reopened.run_until_idle()
    assert len(reopened.pending_approvals()) == 1
    assert [e.type for e in reopened.graph.events].count("pack.loaded") == 1
    numbers = [int(e.id.removeprefix("evt_")) for e in reopened.graph.events]
    assert numbers == list(range(1, len(numbers) + 1))
    _close(reopened)


def test_truncate_after_and_replay_rebuilds_truncated_prefix(event_store) -> None:
    """Truncating a run's event log and replaying rebuilds only the prefix
    state, and subsequent appends continue cleanly from the truncated head."""
    store_url = event_store.url
    runtime = open_runtime(store_url, run_id="canonical_truncate")
    first_person = _person(runtime, "canonical:keep")
    runtime.run_until_idle()
    cut_event_id = runtime.graph.events[-1].id

    dropped_person = _person(runtime, "canonical:drop")
    runtime.run_until_idle()
    runtime.save_state()
    _close(runtime)

    store = open_store(store_url, run_id="canonical_truncate")
    try:
        store.truncate_after(cut_event_id)
    finally:
        store.close()

    reopened = open_runtime(store_url, run_id="canonical_truncate")
    assert reopened.graph.get_object(first_person.id) is not None
    assert reopened.graph.get_object(dropped_person.id) is None

    continued = _person(reopened, "canonical:after-truncate")
    reopened.run_until_idle()
    reopened.save_state()
    _close(reopened)

    final = replay_runtime(store_url, run_id="canonical_truncate")
    keys = sorted(
        obj.data["person_key"]
        for obj in final.graph.all_objects()
        if obj.type == "person"
    )
    assert keys == ["canonical:after-truncate", "canonical:keep"]
    _close(final)
