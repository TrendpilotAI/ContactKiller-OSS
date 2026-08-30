from __future__ import annotations

import pytest
from activegraph import Graph, Runtime
from activegraph.packs import PackSchemaViolation, load_by_name
from activegraph_contactkiller import pack
from activegraph_contactkiller.models import sha256_text


def test_pack_is_discoverable_and_loads() -> None:
    assert load_by_name("contactkiller") == pack

    runtime = Runtime(Graph(run_id="run_pack_load"))
    assert runtime.load_pack(pack) is True
    assert runtime.load_pack(pack) is False
    assert [loaded.name for loaded in runtime.loaded_packs()] == ["contactkiller"]
    assert {item.name for item in pack.object_types} == {
        "operation",
        "manifest",
        "source",
        "integration",
        "source_record",
        "identity_observation",
        "person",
        "identity_resolution",
        "activity_update",
        "graph_projection",
        "task",
        "contact_mutation",
    }


def test_source_record_rejects_embedded_raw_payload() -> None:
    runtime = Runtime(Graph(run_id="run_payload_guard"))
    runtime.load_pack(pack)

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


def test_source_record_rejects_signed_or_credentialed_payload_uri() -> None:
    runtime = Runtime(Graph(run_id="run_uri_secret_guard"))
    runtime.load_pack(pack)

    with pytest.raises(PackSchemaViolation):
        runtime.graph.add_object(
            "source_record",
            {
                "source_record_key": "mesh:signed-url",
                "source_key": "mesh:example-workspace",
                "external_id": "signed-url",
                "payload_uri": "https://example.com/contact.json?token=not-for-events",
                "payload_sha256": "d" * 64,
                "schema_version": "mesh-v2",
                "observed_at": "2026-08-30T12:00:00Z",
            },
        )


def test_pack_declares_both_write_approval_gates() -> None:
    gated = {item for policy in pack.policies for item in policy.requires_approval}
    assert gated == {"identity_resolution", "contact_mutation"}


@pytest.mark.parametrize(
    "credential_ref",
    (
        "secret://operator@credential-store/mesh",
        "secret://operator:password@credential-store/mesh",
        "secret://credential-store/mesh?version=1",
        "secret://credential-store/mesh#current",
    ),
)
def test_credential_reference_rejects_embedded_authority_or_parameters(
    credential_ref: str,
) -> None:
    runtime = Runtime(Graph(run_id="run_credential_guard"))
    runtime.load_pack(pack)

    with pytest.raises(PackSchemaViolation):
        runtime.graph.add_object(
            "integration",
            {
                "integration_key": "mesh:primary",
                "provider": "mesh",
                "status": "authenticated",
                "mode": "read_write",
                "credential_ref": credential_ref,
            },
        )


def test_credential_reference_preserves_safe_locator() -> None:
    runtime = Runtime(Graph(run_id="run_credential_reference"))
    runtime.load_pack(pack)
    integration = runtime.graph.add_object(
        "integration",
        {
            "integration_key": "mesh:primary",
            "provider": "mesh",
            "status": "authenticated",
            "mode": "read_write",
            "credential_ref": "env://MESHHQ_ACCESS_TOKEN",
        },
    )

    assert integration.data["credential_ref"] == "env://MESHHQ_ACCESS_TOKEN"


@pytest.mark.parametrize(
    ("object_type", "data"),
    (
        (
            "operation",
            {
                "operation_key": "op:impossible-date",
                "kind": "ingest",
                "status": "running",
                "requested_by": "test",
                "idempotency_key": "op:impossible-date",
                "started_at": "2026-02-30T12:00:00Z",
            },
        ),
        (
            "operation",
            {
                "operation_key": "op:naive-completion",
                "kind": "ingest",
                "status": "succeeded",
                "requested_by": "test",
                "idempotency_key": "op:naive-completion",
                "completed_at": "2026-08-30T12:00:00",
            },
        ),
        (
            "source_record",
            {
                "source_record_key": "mesh:bad-hour",
                "source_key": "mesh:primary",
                "external_id": "bad-hour",
                "payload_uri": "file:///contactkiller/mesh/bad-hour.json",
                "payload_sha256": "e" * 64,
                "schema_version": "mesh-v2",
                "observed_at": "2026-08-30T25:00:00Z",
            },
        ),
        (
            "identity_observation",
            {
                "observation_key": "identity:bad-day",
                "source_record_key": "mesh:bad-day",
                "kind": "name",
                "normalized_value": "Sentinel Friend",
                "value_sha256": sha256_text("Sentinel Friend"),
                "observed_at": "2026-04-31T12:00:00+00:00",
            },
        ),
        (
            "activity_update",
            {
                "activity_key": "activity:naive",
                "person_id": "person:sentinel",
                "source_record_key": "mesh:activity:naive",
                "kind": "contact_change",
                "occurred_at": "2026-08-30T12:00:00",
            },
        ),
    ),
)
def test_timestamps_reject_impossible_or_timezone_naive_values(
    object_type: str, data: dict
) -> None:
    runtime = Runtime(Graph(run_id=f"run_timestamp_guard_{object_type}"))
    runtime.load_pack(pack)

    with pytest.raises(PackSchemaViolation):
        runtime.graph.add_object(object_type, data)


def test_timestamp_validation_preserves_external_string_shape() -> None:
    runtime = Runtime(Graph(run_id="run_timestamp_shape"))
    runtime.load_pack(pack)
    activity = runtime.graph.add_object(
        "activity_update",
        {
            "activity_key": "activity:offset",
            "person_id": "person:sentinel",
            "source_record_key": "mesh:activity:offset",
            "kind": "contact_change",
            "occurred_at": "2026-08-30T12:00:00+05:30",
        },
    )

    assert activity.data["occurred_at"] == "2026-08-30T12:00:00+05:30"


def test_direct_contact_mutation_defaults_to_proposed_not_approved() -> None:
    """PackPolicy declares intent; direct Graph writes still need safe data."""

    runtime = Runtime(Graph(run_id="run_direct_mutation"))
    runtime.load_pack(pack)
    mutation = runtime.graph.add_object(
        "contact_mutation",
        {
            "mutation_key": "mutation:mesh:sentinel",
            "person_id": "person:sentinel",
            "target_integration_id": "integration:mesh",
            "action": "update",
            "field_paths": ["display_name"],
            "reason": "Correct a missing display name after operator review",
        },
    )

    assert mutation.data["status"] == "proposed"
