"""Deterministic ContactKiller behaviors.

Behaviors emit events and proposals only. They never call provider APIs and
never apply contact writes. Identity resolution is deliberately limited to
exact canonical email or E.164 matches; names and external identifiers are
recorded as observations but cannot trigger an automatic candidate.
PackPolicy is declarative rather than an interception boundary, so every
provider-facing gateway must independently require a recorded approval.
"""

from __future__ import annotations

from activegraph.packs import behavior

from .models import IdentityResolution, Task, sha256_text


@behavior(
    name="plan_manifest_reconciliation",
    on=["object.created"],
    where={"object.type": "manifest"},
    creates=["task"],
)
def plan_manifest_reconciliation(event, graph, ctx) -> None:
    """Create exactly one deterministic reconciliation task per manifest."""

    manifest = event.payload["object"]
    manifest_id = manifest["id"]
    data = manifest["data"]
    task_key = f"reconcile:{data['manifest_key']}:{data['version']}"
    if any(
        obj.data.get("task_key") == task_key for obj in ctx.view.objects(type="task")
    ):
        return

    task = graph.add_object(
        "task",
        Task(
            task_key=task_key,
            kind="reconcile_manifest",
            title=f"Reconcile manifest {data['name']} {data['version']}",
            manifest_id=manifest_id,
            priority="high" if data["state"] == "active" else "normal",
            requires_approval=False,
        ).model_dump(),
    )
    graph.add_relation(
        task.id,
        manifest_id,
        "reconciles",
    )


@behavior(
    name="propose_exact_identity_resolution",
    on=["object.created"],
    where={"object.type": "identity_observation"},
    creates=["identity_resolution"],
)
def propose_exact_identity_resolution(event, graph, ctx) -> None:
    """Propose, but never apply, exact email/E.164 identity candidates."""

    current = event.payload["object"]
    current_data = current["data"]
    kind = current_data.get("kind")
    person_id = current_data.get("person_id")
    if kind not in {"email", "e164"} or not person_id:
        return

    for other in ctx.view.objects(type="identity_observation"):
        if other.id == current["id"]:
            continue
        other_data = other.data
        other_person_id = other_data.get("person_id")
        if not other_person_id or other_person_id == person_id:
            continue
        if other_data.get("kind") != kind:
            continue
        if other_data.get("normalized_value") != current_data.get("normalized_value"):
            continue

        person_ids = tuple(sorted((person_id, other_person_id)))
        observation_ids = tuple(sorted((current["id"], other.id)))
        canonical_pair = ":".join((kind, *person_ids, *observation_ids))
        resolution_key = f"exact:{kind}:{sha256_text(canonical_pair)}"
        if _resolution_already_recorded(ctx, resolution_key):
            continue

        proposal = IdentityResolution(
            resolution_key=resolution_key,
            candidate_person_ids=person_ids,
            evidence_observation_ids=observation_ids,
            match_kind=kind,
            match_value_sha256=current_data["value_sha256"],
            status="approved",
        )
        ctx.propose_object(
            "identity_resolution",
            proposal.model_dump(),
            reason=f"Exact canonical {kind} match; human approval required",
        )


def _resolution_already_recorded(ctx, resolution_key: str) -> bool:
    if any(
        obj.data.get("resolution_key") == resolution_key
        for obj in ctx.view.objects(type="identity_resolution")
    ):
        return True
    return any(
        pending.object_type == "identity_resolution"
        and pending.data.get("resolution_key") == resolution_key
        for pending in ctx._runtime.pending_approvals()
    )


BEHAVIORS = (
    plan_manifest_reconciliation,
    propose_exact_identity_resolution,
)


__all__ = ["BEHAVIORS"]
