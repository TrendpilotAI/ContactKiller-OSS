from __future__ import annotations

from activegraph import Graph, Runtime
from activegraph_contactkiller import pack
from activegraph_contactkiller.models import sha256_text


def _runtime(run_id: str) -> Runtime:
    runtime = Runtime(Graph(run_id=run_id))
    runtime.load_pack(pack)
    return runtime


def test_manifest_deterministically_creates_reconciliation_task() -> None:
    runtime = _runtime("run_manifest_behavior")
    manifest = runtime.graph.add_object(
        "manifest",
        {
            "manifest_key": "contacts:canonical:v1",
            "name": "Canonical contact source policy",
            "version": "1.0.0",
            "state": "active",
            "content_uri": "file:///manifests/contact-policy-v1.json",
            "content_sha256": "b" * 64,
            "created_by": "test-reviewer",
        },
    )

    runtime.run_until_idle()

    tasks = [item for item in runtime.graph.all_objects() if item.type == "task"]
    assert len(tasks) == 1
    assert tasks[0].data == {
        "task_key": "reconcile:contacts:canonical:v1:1.0.0",
        "kind": "reconcile_manifest",
        "title": "Reconcile manifest Canonical contact source policy 1.0.0",
        "status": "open",
        "priority": "high",
        "manifest_id": manifest.id,
        "operation_id": None,
        "requires_approval": False,
    }
    relations = runtime.graph.all_relations()
    assert [(item.source, item.target, item.type) for item in relations] == [
        (tasks[0].id, manifest.id, "reconciles")
    ]


def test_identity_resolution_is_exact_and_approval_gated() -> None:
    runtime = _runtime("run_identity_gate")
    first_person = runtime.graph.add_object(
        "person", {"person_key": "person:sentinel-a", "display_name": "Sentinel Friend"}
    )
    second_person = runtime.graph.add_object(
        "person", {"person_key": "person:sentinel-b", "display_name": "Sentinel F."}
    )
    runtime.run_until_idle()

    canonical_email = "sentinel@example.com"
    digest = sha256_text(canonical_email)
    runtime.graph.add_object(
        "identity_observation",
        {
            "observation_key": "icloud:sentinel",
            "source_record_key": "icloud:record:1",
            "person_id": first_person.id,
            "kind": "email",
            "normalized_value": "Sentinel@Example.COM",
            "value_sha256": digest,
            "observed_at": "2026-08-30T12:00:00Z",
        },
    )
    runtime.run_until_idle()
    assert runtime.pending_approvals() == []

    runtime.graph.add_object(
        "identity_observation",
        {
            "observation_key": "mesh:sentinel",
            "source_record_key": "mesh:record:9",
            "person_id": second_person.id,
            "kind": "email",
            "normalized_value": canonical_email,
            "value_sha256": digest,
            "observed_at": "2026-08-30T12:01:00Z",
        },
    )
    runtime.run_until_idle()

    assert not any(
        item.type == "identity_resolution" for item in runtime.graph.all_objects()
    )
    pending = runtime.pending_approvals()
    assert len(pending) == 1
    assert pending[0].object_type == "identity_resolution"
    assert pending[0].data["match_kind"] == "email"
    assert pending[0].data["match_value_sha256"] == digest
    assert canonical_email not in str(pending[0].data)

    resolution_id = runtime.approve(pending[0].id, approved_by="test-reviewer")
    resolution = runtime.graph.get_object(resolution_id)
    assert resolution is not None
    assert resolution.type == "identity_resolution"
    assert resolution.data["status"] == "approved"


def test_name_match_never_proposes_identity_resolution() -> None:
    runtime = _runtime("run_no_fuzzy_name")
    people = [
        runtime.graph.add_object(
            "person",
            {"person_key": f"person:{index}", "display_name": "Sentinel Friend"},
        )
        for index in range(2)
    ]
    runtime.run_until_idle()
    value = "sentinel friend"
    for index, person in enumerate(people):
        runtime.graph.add_object(
            "identity_observation",
            {
                "observation_key": f"name:{index}",
                "source_record_key": f"source:record:{index}",
                "person_id": person.id,
                "kind": "name",
                "normalized_value": value,
                "value_sha256": sha256_text(value),
                "observed_at": f"2026-08-30T12:0{index}:00Z",
            },
        )
        runtime.run_until_idle()

    assert runtime.pending_approvals() == []


def test_e164_resolution_requires_an_exact_value() -> None:
    runtime = _runtime("run_exact_e164")
    people = [
        runtime.graph.add_object("person", {"person_key": f"phone-person:{index}"})
        for index in range(3)
    ]
    runtime.run_until_idle()
    values = ("+12025550123", "+12025550124", "+12025550123")
    for index, (person, value) in enumerate(zip(people, values, strict=True)):
        runtime.graph.add_object(
            "identity_observation",
            {
                "observation_key": f"phone:{index}",
                "source_record_key": f"phone-source:{index}",
                "person_id": person.id,
                "kind": "e164",
                "normalized_value": value,
                "value_sha256": sha256_text(value),
                "observed_at": f"2026-08-30T13:0{index}:00Z",
            },
        )
        runtime.run_until_idle()

    pending = runtime.pending_approvals()
    assert len(pending) == 1
    assert pending[0].data["match_kind"] == "e164"
    assert pending[0].data["candidate_person_ids"] == tuple(
        sorted((people[0].id, people[2].id))
    )
