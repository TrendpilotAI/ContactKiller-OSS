"""ActiveGraph appends to the EventStore before it projects (CONTRACT v1.11).

With both stores in SurrealDB these are still two writes, not one
transaction. The guarantees checked here: an event is durable (visible to a
separate reader) before its projection write starts, and a failed projection
write loses no event, so replaying the log rebuilds the projection.
"""

from __future__ import annotations

from typing import Any

import pytest
from activegraph.core.graph import Graph, Object
from activegraph.core.ids import IDGen
from activegraph.store.base import replay_into

from activegraph_surrealdb import SurrealGraphStore
from surreal_support import Session


class _ObservingGraphStore(SurrealGraphStore):
    """Records, at each object write, whether the creating event is already
    readable through an independent EventStore handle."""

    def __init__(self, *args: Any, reader: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.reader = reader
        self.observed: list[tuple[str, bool]] = []

    def put_object(self, obj: Object) -> None:
        durable = any(
            event.type == "object.created" and event.payload["object"]["id"] == obj.id
            for event in self.reader.iter_events()
        )
        self.observed.append((obj.id, durable))
        super().put_object(obj)


class _FailingGraphStore(SurrealGraphStore):
    def put_object(self, obj: Object) -> None:
        raise RuntimeError("projection backend unavailable")


def _projection(graph: Graph) -> list[dict[str, Any]]:
    return sorted((obj.to_dict() for obj in graph.all_objects()), key=lambda o: o["id"])


def test_event_is_durable_before_projection(session: Session) -> None:
    writer = session.event_store("run_order")
    reader = session.event_store("run_order")
    projection = _ObservingGraphStore(session.client, graph_id="live", reader=reader)
    graph = Graph(ids=IDGen(), run_id="run_order", graph_store=projection)
    graph.attach_store(writer)

    first = graph.add_object("memo", {"text": "one"})
    second = graph.add_object("memo", {"text": "two"})
    graph.patch_object(first.id, {"text": "uno"})

    assert projection.observed[:2] == [(first.id, True), (second.id, True)]
    assert all(durable for _, durable in projection.observed)
    assert reader.count() == len(graph.events) == 3
    assert projection.get_object(first.id).data == {"text": "uno"}


def test_failed_projection_does_not_lose_the_event(session: Session) -> None:
    writer = session.event_store("run_fail")
    graph = Graph(
        ids=IDGen(),
        run_id="run_fail",
        graph_store=_FailingGraphStore(session.client, graph_id="broken"),
    )
    graph.attach_store(writer)

    with pytest.raises(RuntimeError, match="projection backend unavailable"):
        graph.add_object("memo", {"text": "kept"})

    reader = session.event_store("run_fail")
    events = list(reader.iter_events())
    assert [event.type for event in events] == ["object.created"]
    assert events[0].payload["object"]["data"] == {"text": "kept"}

    rebuilt = Graph(
        ids=IDGen(),
        run_id="run_fail",
        graph_store=session.graph_store("rebuilt"),
    )
    assert replay_into(rebuilt, reader.iter_events()) == 1
    assert [obj.data for obj in rebuilt.all_objects()] == [{"text": "kept"}]


def test_projection_persists_across_handles(session: Session) -> None:
    graph = Graph(
        ids=IDGen(), run_id="run_persist", graph_store=session.graph_store("persist")
    )
    graph.attach_store(session.event_store("run_persist"))
    memo = graph.add_object("memo", {"text": "a"})
    note = graph.add_object("note", {"text": "b"})
    graph.add_relation(memo.id, note.id, "links")

    # A new handle, on a new connection where the target allows one.
    reopened = session.graph_store("persist", shared=not session.reconnectable)
    assert sorted(o.id for o in reopened.all_objects()) == sorted([memo.id, note.id])
    assert [(r.source, r.target, r.type) for r in reopened.all_relations()] == [
        (memo.id, note.id, "links")
    ]
    assert _projection(graph) == sorted(
        (obj.to_dict() for obj in reopened.all_objects()), key=lambda o: o["id"]
    )
