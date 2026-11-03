"""SurrealDB-backed ActiveGraph GraphStore (the materialized projection).

The projection is a durable copy of current state, not a second source of
truth: ActiveGraph appends each event to the EventStore before projecting it,
and a lost or divergent projection is rebuilt by replaying the log into an
empty store. ``graph_id`` scopes one projection, so several (for example one
per run) can share a database.

Object, relation and patch bodies are stored as JSON strings so values round
trip exactly. Each method is one SurrealQL request; :meth:`clear` runs in a
transaction. ``find_objects`` and ``find_relations`` filter in the database;
every other query hook uses the GraphStore base-class defaults, which define
the semantics GraphStoreConformance checks.
"""

from __future__ import annotations

import json
from typing import Any, Optional

from activegraph.core.graph import Object, Relation
from activegraph.core.graph_store import GraphStore
from activegraph.core.patch import Patch

from ._client import Connection
from .schema import _apply as _apply_schema

_CLEAR = """
BEGIN TRANSACTION;
DELETE ag_object WHERE graph_id = $graph_id;
DELETE ag_relation WHERE graph_id = $graph_id;
DELETE ag_patch WHERE graph_id = $graph_id;
COMMIT TRANSACTION;
"""


class SurrealGraphStore(GraphStore):
    """GraphStore persisted in the ``ag_object``, ``ag_relation`` and
    ``ag_patch`` tables. ``target`` takes the same URL or client forms as
    :class:`~activegraph_surrealdb.SurrealEventStore`."""

    def __init__(
        self,
        target: Any,
        namespace: Optional[str] = None,
        database: Optional[str] = None,
        *,
        graph_id: str = "default",
        username: Optional[str] = None,
        password: Optional[str] = None,
        ensure_schema: bool = True,
    ) -> None:
        if not graph_id:
            raise ValueError("graph_id must be a non-empty string")
        self.graph_id = graph_id
        self._conn = Connection(
            target, namespace=namespace, database=database, username=username, password=password
        )
        try:
            if ensure_schema:
                _apply_schema(self._conn)
        except BaseException:
            self._conn.close()
            raise

    def __repr__(self) -> str:
        return f"SurrealGraphStore(graph_id={self.graph_id!r})"

    # ---- objects ----

    def put_object(self, obj: Object) -> None:
        self._conn.query(
            "UPSERT $record CONTENT $content;",
            {
                "record": self._record("ag_object", obj.id),
                "content": {
                    "graph_id": self.graph_id,
                    "object_id": obj.id,
                    "type": obj.type,
                    "version": obj.version,
                    "data": _dump(obj.data),
                    "provenance": _dump(obj.provenance),
                },
            },
        )

    def get_object(self, object_id: str) -> Optional[Object]:
        row = self._get("ag_object", object_id)
        return _object(row) if row else None

    def remove_object(self, object_id: str) -> None:
        self._delete("ag_object", object_id)

    def all_objects(self) -> list[Object]:
        return [_object(row) for row in self._select("ag_object")]

    def find_objects(self, type: Optional[str] = None) -> list[Object]:
        if type is None:
            return self.all_objects()
        return [_object(row) for row in self._select("ag_object", "type = $type", type=type)]

    # ---- relations ----

    def put_relation(self, rel: Relation) -> None:
        self._conn.query(
            "UPSERT $record CONTENT $content;",
            {
                "record": self._record("ag_relation", rel.id),
                "content": {
                    "graph_id": self.graph_id,
                    "relation_id": rel.id,
                    "source": rel.source,
                    "target": rel.target,
                    "type": rel.type,
                    "data": _dump(rel.data),
                    "provenance": _dump(rel.provenance),
                },
            },
        )

    def get_relation(self, relation_id: str) -> Optional[Relation]:
        row = self._get("ag_relation", relation_id)
        return _relation(row) if row else None

    def remove_relation(self, relation_id: str) -> None:
        self._delete("ag_relation", relation_id)

    def all_relations(self) -> list[Relation]:
        return [_relation(row) for row in self._select("ag_relation")]

    def find_relations(
        self,
        source: Optional[str] = None,
        target: Optional[str] = None,
        type: Optional[str] = None,
    ) -> list[Relation]:
        clauses = []
        params: dict[str, Any] = {}
        for name, value in (("source", source), ("target", target), ("type", type)):
            if value is not None:
                clauses.append(f"{name} = ${name}")
                params[name] = value
        rows = self._select("ag_relation", " AND ".join(clauses) or None, **params)
        return [_relation(row) for row in rows]

    # ---- patches ----

    def put_patch(self, patch: Patch) -> None:
        self._conn.query(
            "UPSERT $record CONTENT $content;",
            {
                "record": self._record("ag_patch", patch.id),
                "content": {
                    "graph_id": self.graph_id,
                    "patch_id": patch.id,
                    "target": patch.target,
                    "status": patch.status,
                    "patch": _dump(patch.to_dict()),
                },
            },
        )

    def get_patch(self, patch_id: str) -> Optional[Patch]:
        row = self._get("ag_patch", patch_id)
        return _patch(row) if row else None

    def remove_patch(self, patch_id: str) -> None:
        self._delete("ag_patch", patch_id)

    def all_patches(self) -> list[Patch]:
        return [_patch(row) for row in self._select("ag_patch")]

    # ---- lifecycle ----

    def clear(self) -> None:
        """Drop this projection's objects, relations and patches atomically."""
        self._conn.query(_CLEAR, {"graph_id": self.graph_id})

    def close(self) -> None:
        self._conn.close()

    # ---- internals ----

    def _record(self, table: str, entity_id: str) -> Any:
        from surrealdb import RecordID

        return RecordID(table, [self.graph_id, entity_id])

    def _get(self, table: str, entity_id: str) -> Optional[dict[str, Any]]:
        return self._conn.query(
            "SELECT * FROM ONLY $record;", {"record": self._record(table, entity_id)}
        )[0]

    def _delete(self, table: str, entity_id: str) -> None:
        self._conn.query("DELETE $record;", {"record": self._record(table, entity_id)})

    def _select(self, table: str, where: Optional[str] = None, **params: Any) -> list[dict[str, Any]]:
        condition = "graph_id = $graph_id" + (f" AND {where}" if where else "")
        return self._conn.query(
            f"SELECT * FROM {table} WHERE {condition};", {"graph_id": self.graph_id, **params}
        )[0]


def _dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def _object(row: dict[str, Any]) -> Object:
    return Object(
        id=row["object_id"],
        type=row["type"],
        data=json.loads(row["data"]),
        version=int(row["version"]),
        provenance=json.loads(row["provenance"]),
    )


def _relation(row: dict[str, Any]) -> Relation:
    return Relation(
        id=row["relation_id"],
        source=row["source"],
        target=row["target"],
        type=row["type"],
        data=json.loads(row["data"]),
        provenance=json.loads(row["provenance"]),
    )


def _patch(row: dict[str, Any]) -> Patch:
    body = json.loads(row["patch"])
    return Patch(
        id=body["id"],
        target=body["target"],
        op=body["op"],
        value=body["value"],
        expected_version=body["expected_version"],
        proposed_by=body["proposed_by"],
        rationale=body.get("rationale"),
        evidence=list(body.get("evidence", [])),
        status=body.get("status", "proposed"),
        rejection_reason=body.get("rejection_reason"),
        provenance=body.get("provenance", {}),
    )
