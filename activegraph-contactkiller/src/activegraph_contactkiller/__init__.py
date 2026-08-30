"""ContactKiller's event-sourced ActiveGraph pack.

The event log is authoritative. Every graph object and relation is a derived,
replayable projection. Provider secrets are represented only by credential
references; raw contact payloads are represented only by URI and hash.
Pack policies declare approval intent and route explicit proposals; they are
not a security boundary for direct graph mutations. Provider gateways must
verify recorded approval before performing any external write.
"""

from __future__ import annotations

from activegraph.packs import Pack, PackPolicy

from .behaviors import BEHAVIORS
from .object_types import OBJECT_TYPES, RELATION_TYPES

pack = Pack(
    name="contactkiller",
    version="0.1.0",
    description=(
        "Auditable contact provenance, exact-match identity proposals, "
        "reconciliation tasks, graph projections, and approval-routed proposals."
    ),
    object_types=OBJECT_TYPES,
    relation_types=RELATION_TYPES,
    behaviors=BEHAVIORS,
    policies=(
        PackPolicy(
            name="identity_resolution_approval",
            requires_approval=("identity_resolution",),
        ),
        PackPolicy(
            name="contact_mutation_approval",
            requires_approval=("contact_mutation",),
        ),
    ),
)


__all__ = ["pack"]
