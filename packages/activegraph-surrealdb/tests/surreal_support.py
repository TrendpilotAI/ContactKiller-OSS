"""SurrealDB test targets and per-test sessions.

Targets:

- ``server``: the URL in ``ACTIVEGRAPH_SURREALDB_TEST_URL`` (credentials in
  ``ACTIVEGRAPH_SURREALDB_TEST_USER`` / ``ACTIVEGRAPH_SURREALDB_TEST_PASS``);
  skipped when the variable is unset.
- ``mem``: embedded ``mem://``; skipped when the installed SDK cannot open it.
- ``surrealkv``: embedded ``surrealkv://`` in a temporary directory; skipped
  likewise.

Every session gets a fresh random namespace and database. Closing it closes
the stores it opened and then removes the namespace (server) or the data
directory (surrealkv).
"""

from __future__ import annotations

import os
import shutil
import tempfile
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional

from activegraph.core.event import Event
from surrealdb import Surreal

from activegraph_surrealdb import SurrealEventStore, SurrealGraphStore

ENV_URL = "ACTIVEGRAPH_SURREALDB_TEST_URL"
ENV_USER = "ACTIVEGRAPH_SURREALDB_TEST_USER"
ENV_PASS = "ACTIVEGRAPH_SURREALDB_TEST_PASS"


def _embedded_skip_reason() -> Optional[str]:
    try:
        client = Surreal("mem://")
        client.connect()
        client.use("probe", "probe")
        client.query_raw("RETURN 1;")
        client.close()
    except Exception as exc:  # pragma: no cover - depends on the installed SDK
        return f"the installed surrealdb SDK cannot open embedded databases: {exc}"
    return None


@dataclass(frozen=True)
class Target:
    name: str
    kind: str  # "server" | "mem" | "surrealkv"
    url: Optional[str] = None
    username: Optional[str] = None
    password: Optional[str] = field(default=None, repr=False)
    skip_reason: Optional[str] = None

    def session(self) -> "Session":
        return Session(self)


def _server_target() -> Target:
    url = os.environ.get(ENV_URL)
    if not url:
        return Target(
            "server",
            "server",
            skip_reason=f"{ENV_URL} is not set; set it (with {ENV_USER} and {ENV_PASS}) to test a SurrealDB server",
        )
    return Target(
        "server",
        "server",
        url=url,
        username=os.environ.get(ENV_USER),
        password=os.environ.get(ENV_PASS),
    )


_EMBEDDED_SKIP = _embedded_skip_reason()
SERVER = _server_target()
MEM = Target("mem", "mem", url="mem://", skip_reason=_EMBEDDED_SKIP)
SURREALKV = Target("surrealkv", "surrealkv", skip_reason=_EMBEDDED_SKIP)
ALL_TARGETS = (SERVER, MEM, SURREALKV)

# Explicit tests run against the server when configured, else embedded mem://.
PRIMARY = SERVER if SERVER.skip_reason is None else MEM


class Session:
    """One fresh namespace/database on a target."""

    def __init__(self, target: Target) -> None:
        if target.skip_reason:
            raise RuntimeError(target.skip_reason)
        self.target = target
        self.namespace = f"agtest_{uuid.uuid4().hex[:12]}"
        self.database = f"db_{uuid.uuid4().hex[:8]}"
        self._tmpdir: Optional[str] = None
        if target.kind == "surrealkv":
            self._tmpdir = tempfile.mkdtemp(prefix="ag-surrealkv-")
            self.url = f"surrealkv://{self._tmpdir}/data"
        else:
            assert target.url is not None
            self.url = target.url
        self._client: Optional[Any] = None
        self._extra_clients: list[Any] = []
        self._closables: list[Any] = []

    # ---- connections ----

    @property
    def auth(self) -> dict[str, Optional[str]]:
        if self.target.kind != "server":
            return {}
        return {"username": self.target.username, "password": self.target.password}

    @property
    def reconnectable(self) -> bool:
        """True when a second connection sees the same data (not mem://)."""
        return self.target.kind == "server"

    @property
    def client(self) -> Any:
        """A shared client on this session's database (opened on first use)."""
        if self._client is None:
            self._client = self._connect()
        return self._client

    def new_client(self) -> Any:
        """An independent connection to the same database (server only)."""
        if self.target.kind != "server":
            raise RuntimeError("independent connections need a server target")
        client = self._connect()
        self._extra_clients.append(client)
        return client

    def _connect(self) -> Any:
        client = Surreal(self.url)
        if self.target.kind != "server":
            client.connect()
        elif self.target.username is not None:
            client.signin({"username": self.target.username, "password": self.target.password})
        client.use(self.namespace, self.database)
        return client

    # ---- stores ----

    def event_store(self, run_id: str, *, shared: bool = True, **kwargs: Any) -> SurrealEventStore:
        """A store on the shared client, or (``shared=False``) one that opens
        and owns its own connection from the URL."""
        if shared:
            store = SurrealEventStore(self.client, run_id=run_id, **kwargs)
        else:
            store = SurrealEventStore(
                self.url, self.namespace, self.database, run_id=run_id, **self.auth, **kwargs
            )
        self._closables.append(store)
        return store

    def graph_store(self, graph_id: str = "default", *, shared: bool = True) -> SurrealGraphStore:
        if shared:
            store = SurrealGraphStore(self.client, graph_id=graph_id)
        else:
            store = SurrealGraphStore(
                self.url, self.namespace, self.database, graph_id=graph_id, **self.auth
            )
        self._closables.append(store)
        return store

    # ---- teardown ----

    def close(self) -> None:
        for closable in reversed(self._closables):
            try:
                closable.close()
            except Exception:
                pass
        self._closables.clear()
        if self.target.kind == "server":
            admin = self._client or self._connect()
            try:
                admin.query_raw(f"REMOVE NAMESPACE IF EXISTS {self.namespace};", {})
            finally:
                if admin is not self._client:
                    admin.close()
        for client in [*self._extra_clients, self._client]:
            if client is not None:
                try:
                    client.close()
                except Exception:
                    pass
        self._client = None
        self._extra_clients.clear()
        if self._tmpdir is not None:
            shutil.rmtree(self._tmpdir, ignore_errors=True)


def make_event(event_id: str, type_: str = "object.created", payload: Optional[dict] = None) -> Event:
    return Event(
        id=event_id,
        type=type_,
        payload=payload if payload is not None else {"k": event_id},
        actor="test",
        frame_id=None,
        caused_by=None,
        timestamp="2026-01-01T00:00:00Z",
    )
