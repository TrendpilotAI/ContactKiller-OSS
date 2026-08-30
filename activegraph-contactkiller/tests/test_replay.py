from __future__ import annotations

import sqlite3

import pytest
from activegraph_contactkiller.models import sha256_text
from activegraph_contactkiller.runtime import (
    InconsistentRunStoreError,
    RunAlreadyExistsError,
    RunNotFoundError,
    create_runtime,
    open_runtime,
    replay_runtime,
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


def test_sqlite_event_log_replays_the_same_graph_projection(tmp_path) -> None:
    store_url = f"sqlite:///{tmp_path / 'contactkiller-events.sqlite'}"
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


def test_identity_approval_survives_sqlite_replay_and_can_be_granted(tmp_path) -> None:
    store_url = f"sqlite:///{tmp_path / 'pending-approval.sqlite'}"
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


def test_create_runtime_fails_clearly_when_run_already_exists(tmp_path) -> None:
    store_url = f"sqlite:///{tmp_path / 'create-only.sqlite'}"
    create_runtime(store_url, run_id="canonical_contacts")

    with pytest.raises(RunAlreadyExistsError, match="use open_runtime"):
        create_runtime(store_url, run_id="canonical_contacts")


def test_open_runtime_creates_then_replays_canonical_run(tmp_path) -> None:
    store_url = f"sqlite:///{tmp_path / 'open-canonical.sqlite'}"
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


def test_replay_runtime_does_not_create_a_missing_run(tmp_path) -> None:
    store_url = f"sqlite:///{tmp_path / 'replay-only.sqlite'}"

    with pytest.raises(RunNotFoundError, match="use open_runtime"):
        replay_runtime(store_url, run_id="missing_contacts")


def test_open_runtime_refuses_orphaned_events_instead_of_recreating(tmp_path) -> None:
    store_path = tmp_path / "orphaned-events.sqlite"
    store_url = f"sqlite:///{store_path}"
    runtime = create_runtime(store_url, run_id="canonical_contacts")
    runtime.graph.store.close()
    with sqlite3.connect(store_path) as connection:
        connection.execute("DELETE FROM runs WHERE run_id = ?", ("canonical_contacts",))

    with pytest.raises(InconsistentRunStoreError, match="refusing to create"):
        open_runtime(store_url, run_id="canonical_contacts")
