"""End-to-end smoke test over every target and URL form.

Opens the store from a URL with ``open_surreal_store``, writes a small graph
through ActiveGraph, truncates, and replays into a SurrealDB projection. For a
server target the same flow also runs over HTTP (the ws URL with an http
scheme), since every SDK transport must work.
"""

from __future__ import annotations

from collections.abc import Iterator
from urllib.parse import urlsplit, urlunsplit

import pytest
from activegraph.core.graph import Graph
from activegraph.core.ids import IDGen
from activegraph.store.base import replay_into
from activegraph.store.errors import EventNotFoundError

from activegraph_surrealdb import SurrealGraphStore, apply_schema, open_surreal_store
from surreal_support import ALL_TARGETS, SERVER, Session, Target, make_event


def _http_variant(url: str) -> str:
    parts = urlsplit(url)
    scheme = {"ws": "http", "wss": "https"}.get(parts.scheme, parts.scheme)
    path = parts.path[: -len("/rpc")] if parts.path.endswith("/rpc") else parts.path
    return urlunsplit((scheme, parts.netloc, path, "", ""))


def _cases() -> list:
    cases = [
        pytest.param((target, None), id=target.name,
                     marks=pytest.mark.skipif(target.skip_reason is not None,
                                              reason=target.skip_reason or ""))
        for target in ALL_TARGETS
    ]
    http_url = _http_variant(SERVER.url) if SERVER.url else None
    cases.append(
        pytest.param((SERVER, http_url), id="server-http",
                     marks=pytest.mark.skipif(SERVER.skip_reason is not None,
                                              reason=SERVER.skip_reason or ""))
    )
    return cases


@pytest.fixture(params=_cases())
def target_session(request: pytest.FixtureRequest) -> Iterator[tuple[Session, str]]:
    target, url_override = request.param
    current = target.session()
    try:
        yield current, url_override or current.url
    finally:
        current.close()


def test_smoke_round_trip(target_session: tuple[Session, str]) -> None:
    session, base_url = target_session
    url = f"surrealdb+{base_url}?ns={session.namespace}&db={session.database}"
    store = open_surreal_store(url, "run_smoke", **session.auth)
    projection = SurrealGraphStore(store._conn.client, graph_id="smoke")  # noqa: SLF001
    try:
        apply_schema(store._conn.client)  # idempotent re-apply  # noqa: SLF001
        store.upsert_run(created_at="2026-01-01T00:00:00Z", label="smoke")
        graph = Graph(ids=IDGen(), run_id="run_smoke", graph_store=projection)
        graph.attach_store(store)
        memo = graph.add_object("memo", {"text": "hello", "n": 1})
        note = graph.add_object("note", {"text": "café — 🚀"})
        graph.add_relation(memo.id, note.id, "links")
        graph.patch_object(memo.id, {"n": 2})
        events = list(store.iter_events())
        assert [e.id for e in events] == [e.id for e in graph.events]
        assert store.get_run().label == "smoke"

        store.truncate_after(events[1].id)
        assert store.count() == 2
        with pytest.raises(EventNotFoundError):
            store.truncate_after("evt_missing")

        rebuilt = Graph(ids=IDGen(), run_id="run_smoke",
                        graph_store=SurrealGraphStore(store._conn.client, graph_id="rebuilt"))  # noqa: SLF001
        replay_into(rebuilt, store.iter_events())
        assert sorted(o.data["text"] for o in rebuilt.all_objects()) == ["café — 🚀", "hello"]
        assert rebuilt.all_relations() == []
        assert len(projection.all_objects()) == 2
    finally:
        projection.close()
        store.close()


@pytest.mark.parametrize(
    "target",
    [pytest.param(t, id=t.name, marks=pytest.mark.skipif(t.skip_reason is not None,
                                                         reason=t.skip_reason or ""))
     for t in ALL_TARGETS],
)
def test_iteration_pages_through_long_logs(target: Target) -> None:
    session = target.session()
    try:
        store = session.event_store("run_pages", page_size=3)
        for i in range(10):
            store.append(make_event(f"evt_{i:02d}"))
        assert [e.id for e in store.iter_events()] == [f"evt_{i:02d}" for i in range(10)]
        assert [e.id for e in store.iter_events(after="evt_02", until="evt_08")] == [
            f"evt_{i:02d}" for i in range(3, 9)
        ]
        with pytest.raises(EventNotFoundError):
            list(store.iter_events(after="evt_missing"))
    finally:
        session.close()
