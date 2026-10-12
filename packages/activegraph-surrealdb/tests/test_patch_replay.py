"""Patch events through the SurrealDB store: PATCH_OPS stays enforced on
replay, and valid patch histories replay to the same graph."""

from __future__ import annotations

from typing import Any

import pytest
from activegraph import Runtime
from activegraph.core.event import Event
from activegraph.core.graph import Graph
from activegraph.core.ids import IDGen
from activegraph.core.patch import PATCH_OPS
from activegraph.packs import behavior
from activegraph.runtime.exec_errors import InvalidPatchOperation
from activegraph.store.base import replay_into

from surreal_support import Session

INVALID_OP = "delete"


def _bad_patch_event(target: str) -> Event:
    return Event(
        id="evt_bad_patch",
        type="patch.applied",
        payload={
            "patch": {
                "id": "patch_bad",
                "target": target,
                "op": INVALID_OP,
                "value": {},
                "expected_version": 1,
                "proposed_by": "test",
                "evidence": [],
                "status": "applied",
                "provenance": {},
            }
        },
        actor="test",
        frame_id=None,
        caused_by=None,
        timestamp="2026-01-01T00:00:00Z",
    )


def _state(graph: Graph) -> dict[str, Any]:
    def by_id(items: list[Any]) -> list[dict[str, Any]]:
        return sorted((item.to_dict() for item in items), key=lambda d: d["id"])

    return {
        "objects": by_id(graph.all_objects()),
        "relations": by_id(graph.all_relations()),
        "patches": by_id(graph._state.all_patches()),  # noqa: SLF001
    }


def test_invalid_patch_op_is_refused_before_append(session: Session) -> None:
    assert INVALID_OP not in PATCH_OPS
    store = session.event_store("run_patch_live")
    graph = Graph(ids=IDGen(), run_id="run_patch_live")
    graph.attach_store(store)
    memo = graph.add_object("memo", {"text": "a"})

    with pytest.raises(InvalidPatchOperation):
        graph.emit(_bad_patch_event(memo.id))

    assert store.count() == 1
    assert store.get_event("evt_bad_patch") is None


def test_replaying_an_invalid_patch_op_raises(session: Session) -> None:
    store = session.event_store("run_patch_replay")
    graph = Graph(ids=IDGen(), run_id="run_patch_replay")
    graph.attach_store(store)
    memo = graph.add_object("memo", {"text": "a"})
    # The log stores what it is given; validation belongs to ActiveGraph's
    # acceptance and replay path, which must reject this event on load.
    store.append(_bad_patch_event(memo.id))

    target = Graph(
        ids=IDGen(),
        run_id="run_patch_replay",
        graph_store=session.graph_store("replay"),
    )
    with pytest.raises(InvalidPatchOperation) as caught:
        replay_into(target, session.event_store("run_patch_replay").iter_events())

    assert caught.value.context["op"] == INVALID_OP
    assert caught.value.context["event_id"] == "evt_bad_patch"
    assert target.get_object(memo.id).data == {"text": "a"}


@behavior(name="edit_memo", on=["object.created"], where={"object.type": "memo"})
def edit_memo(event, graph, ctx) -> None:
    memo_id = event.payload["object"]["id"]
    graph.patch_object(memo_id, {"text": "edited", "tags": ["x"]})
    graph.propose_patch(memo_id, "replace", {"text": "replaced"}, rationale="replace")
    graph.propose_patch(memo_id, "update", {"text": "stale"}, rationale="not needed")
    note = graph.add_object("note", {"about": memo_id})
    graph.add_relation(note.id, memo_id, "annotates")


def test_runtime_patch_history_replays_identically(session: Session) -> None:
    run_id = "run_patch_roundtrip"
    store = session.event_store(run_id)
    live = Graph(ids=IDGen(), run_id=run_id, graph_store=session.graph_store("live"))
    runtime = Runtime(live, behaviors=[edit_memo], store=store)
    runtime.run_goal("edit a memo")
    memo_id = live.add_object("memo", {"text": "draft"}).id
    runtime.run_until_idle()
    proposed = sorted(
        (p for p in live._state.all_patches() if p.status == "proposed"),  # noqa: SLF001
        key=lambda p: p.id,
    )
    replace, stale = proposed
    assert (replace.op, stale.op) == ("replace", "update")
    live.apply_patch(replace.id, approved_by="reviewer")
    live.reject_patch(stale.id, reason="not needed")
    runtime.run_until_idle()

    patch_events = [e for e in live.events if e.type.startswith("patch.")]
    ops = {e.payload["patch"]["op"] for e in patch_events if "patch" in e.payload}
    assert ops == {"update", "replace"}
    assert {e.type for e in patch_events} >= {"patch.proposed", "patch.applied", "patch.rejected"}
    assert store.get_run().goal == "edit a memo"

    reader = session.event_store(run_id)
    stored = list(reader.iter_events())
    assert [e.to_dict() for e in stored] == [e.to_dict() for e in live.events]

    replayed = Graph(ids=IDGen(), run_id=run_id, graph_store=session.graph_store("replayed"))
    assert replay_into(replayed, stored) == len(stored)
    in_memory = Graph(ids=IDGen(), run_id=run_id)
    replay_into(in_memory, reader.iter_events())

    expected = _state(live)
    assert expected["objects"], "the behavior should have produced objects"
    memo = next(o for o in expected["objects"] if o["id"] == memo_id)
    assert memo["data"] == {"text": "replaced"} and memo["version"] == 3
    assert _state(replayed) == expected
    assert _state(in_memory) == expected
