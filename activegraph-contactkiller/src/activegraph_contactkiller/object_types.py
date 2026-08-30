"""ActiveGraph object and relation declarations for ContactKiller."""

from __future__ import annotations

from activegraph.packs import ObjectType, RelationType

from .models import (
    ActivityUpdate,
    ContactMutation,
    GraphProjection,
    IdentityObservation,
    IdentityResolution,
    Integration,
    Manifest,
    Operation,
    Person,
    Source,
    SourceRecord,
    Task,
)

OBJECT_TYPES = (
    ObjectType("operation", Operation, "An auditable unit of work."),
    ObjectType("manifest", Manifest, "A versioned declaration of intended state."),
    ObjectType("source", Source, "A contact or activity source and account boundary."),
    ObjectType(
        "integration", Integration, "A provider connection with credential references."
    ),
    ObjectType(
        "source_record",
        SourceRecord,
        "An immutable reference to an external raw record.",
    ),
    ObjectType(
        "identity_observation",
        IdentityObservation,
        "An identifier observed in a source record.",
    ),
    ObjectType("person", Person, "A canonical person projection."),
    ObjectType(
        "identity_resolution",
        IdentityResolution,
        "A human-approved exact-match resolution.",
    ),
    ObjectType("activity_update", ActivityUpdate, "A normalized person activity."),
    ObjectType(
        "graph_projection",
        GraphProjection,
        "A checkpoint of a derived graph projection.",
    ),
    ObjectType("task", Task, "A deterministic or operator-owned work item."),
    ObjectType(
        "contact_mutation",
        ContactMutation,
        "A proposed contact-system write requiring gateway approval enforcement.",
    ),
)


RELATION_TYPES = (
    RelationType(
        "declared_by",
        source_types=("operation", "task", "graph_projection", "contact_mutation"),
        target_types=("manifest",),
        description="The manifest governing an operation or derived action.",
    ),
    RelationType(
        "uses_integration",
        source_types=("operation", "task", "contact_mutation"),
        target_types=("integration",),
        description="The integration used by an operation or requested mutation.",
    ),
    RelationType(
        "captures",
        source_types=("source_record",),
        target_types=("source",),
        description="The source account from which an immutable record was captured.",
    ),
    RelationType(
        "collected_via",
        source_types=("source_record",),
        target_types=("integration",),
        description="The integration that collected a source record.",
    ),
    RelationType(
        "observed_in",
        source_types=("identity_observation", "activity_update"),
        target_types=("source_record",),
        description="Provenance from a normalized observation to an immutable source record.",
    ),
    RelationType(
        "identifies",
        source_types=("identity_observation",),
        target_types=("person",),
        description="The current person projection associated with an observation.",
    ),
    RelationType(
        "supported_by",
        source_types=("identity_resolution",),
        target_types=("identity_observation",),
        description="Exact-match evidence supporting an approved identity resolution.",
    ),
    RelationType(
        "resolves_person",
        source_types=("identity_resolution",),
        target_types=("person",),
        description="A person participating in an approved resolution.",
    ),
    RelationType(
        "updates_person",
        source_types=("activity_update", "contact_mutation"),
        target_types=("person",),
        description="An activity or mutation affecting a person projection.",
    ),
    RelationType(
        "projects",
        source_types=("graph_projection",),
        target_types=("person", "identity_resolution", "activity_update"),
        description="A graph checkpoint materializes derived domain state.",
    ),
    RelationType(
        "depends_on",
        source_types=("operation", "graph_projection", "task", "contact_mutation"),
        target_types=(
            "operation",
            "manifest",
            "task",
            "source_record",
            "identity_resolution",
        ),
        description="An explicit causal or execution dependency.",
    ),
    RelationType(
        "reconciles",
        source_types=("task",),
        target_types=("manifest",),
        description="A reconciliation task generated for a manifest.",
    ),
)


__all__ = ["OBJECT_TYPES", "RELATION_TYPES"]
