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


@pytest.mark.skipif(SERVER.skip_reason is not None, reason=SERVER.skip_reason or "")
@pytest.mark.parametrize("auth_scope", ["namespace", "database"])
def test_scoped_user_authentication_against_server(auth_scope: str) -> None:
    session = SERVER.session()
    try:
        level = "NAMESPACE" if auth_scope == "namespace" else "DATABASE"
        user = f"scoped_{auth_scope}_user"
        password = "scoped-test-password-123"
        session.client.query_raw(f"DEFINE USER {user} ON {level} PASSWORD '{password}' ROLES OWNER;", {})
        url = f"surrealdb+{session.url}?ns={session.namespace}&db={session.database}"
        store = open_surreal_store(
            url,
            f"run_{auth_scope}",
            username=user,
            password=password,
            auth_scope=auth_scope,
        )
        projection = SurrealGraphStore(
            session.url,
            session.namespace,
            session.database,
            graph_id=f"proj_{auth_scope}",
            username=user,
            password=password,
            auth_scope=auth_scope,
        )
        try:
            apply_schema(
                session.url,
                namespace=session.namespace,
                database=session.database,
                username=user,
                password=password,
                auth_scope=auth_scope,
            )
            store.append(make_event("evt_scoped_1"))
            assert [e.id for e in store.iter_events()] == ["evt_scoped_1"]
            assert projection.all_objects() == []
        finally:
            projection.close()
            store.close()
    finally:
        session.close()


@pytest.mark.parametrize(
    "target",
    [pytest.param(t, id=t.name, marks=pytest.mark.skipif(t.skip_reason is not None,
                                                         reason=t.skip_reason or ""))
     for t in ALL_TARGETS],
)
def test_strict_replay_after_truncation_and_continuation(target: Target) -> None:
    session = target.session()
    try:
        from activegraph import Runtime

        store = session.event_store("run_trunc_replay")
        store.upsert_run(created_at="2026-01-01T00:00:00Z", label="trunc-replay")
        live = Graph(ids=IDGen(), run_id="run_trunc_replay", graph_store=session.graph_store("live"))
        rt = Runtime(live, store=store)
        first = live.add_object("memo", {"text": "keep", "v": 1})
        live.patch_object(first.id, {"text": "keep", "v": 2})
        rt.run_until_idle()
        cut_id = live.events[-1].id

        discarded = live.add_object("memo", {"text": "discard", "v": 99})
        rt.run_until_idle()
        assert live.get_object(discarded.id) is not None

        # Truncate back to cut_id and continue from a replayed handle:
        store.truncate_after(cut_id)
        resumed_store = session.event_store("run_trunc_replay")
        resumed_proj = session.graph_store("resumed")
        resumed_graph = Graph(ids=IDGen(), run_id="run_trunc_replay", graph_store=resumed_proj)
        replay_into(resumed_graph, resumed_store.iter_events())
        resumed_graph.ids.reseed_from_events(resumed_graph.events)
        resumed_graph.attach_store(resumed_store)
        resumed_rt = Runtime(resumed_graph, store=None)

        assert resumed_graph.get_object(first.id).data == {"text": "keep", "v": 2}
        assert resumed_graph.get_object(discarded.id) is None

        replacement = resumed_graph.add_object("memo", {"text": "replacement", "v": 3})
        resumed_rt.run_until_idle()

        final_graph = Graph(ids=IDGen(), run_id="run_trunc_replay", graph_store=session.graph_store("final"))
        replay_into(final_graph, session.event_store("run_trunc_replay").iter_events())
        assert sorted(o.data["text"] for o in final_graph.all_objects()) == ["keep", "replacement"]
        assert final_graph.get_object(replacement.id).data["v"] == 3
    finally:
        session.close()
