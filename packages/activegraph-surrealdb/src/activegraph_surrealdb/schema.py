"""The shipped SurrealQL schema and its idempotent installer."""

from __future__ import annotations

from importlib.resources import files
from typing import Any, Optional

from activegraph.store.errors import SchemaVersionMismatch

from ._client import Connection, tagged_result

SCHEMA_VERSION = "1"


def schema_text() -> str:
    """The SurrealQL schema shipped with this package (``schema.surql``)."""
    return files("activegraph_surrealdb").joinpath("schema.surql").read_text("utf-8")


_VERSION_QUERY = """
UPSERT ag_meta:schema SET version = version ?? $version;
RETURN { ag_schema: true, version: (SELECT VALUE version FROM ONLY ag_meta:schema) };
"""


def apply_schema(
    target: Any,
    *,
    namespace: Optional[str] = None,
    database: Optional[str] = None,
    username: Optional[str] = None,
    password: Optional[str] = None,
) -> None:
    """Define the ActiveGraph tables if missing and check the schema version.

    ``target`` is a URL, a connected ``surrealdb.Surreal`` client, or a
    :class:`~activegraph_surrealdb._client.Connection`. Safe to call on every
    open. Raises :class:`~activegraph.store.errors.SchemaVersionMismatch` when
    the database was initialised by an incompatible version of this package.
    """
    if isinstance(target, Connection):
        _apply(target)
        return
    connection = Connection(
        target, namespace=namespace, database=database, username=username, password=password
    )
    try:
        _apply(connection)
    finally:
        connection.close()


def _apply(connection: Connection) -> None:
    connection.query(schema_text())
    found = tagged_result(
        connection.query(_VERSION_QUERY, {"version": SCHEMA_VERSION}), "ag_schema"
    ).get("version")
    if found != SCHEMA_VERSION:
        raise SchemaVersionMismatch(
            f"SurrealDB schema_version {found!r} does not match this adapter's {SCHEMA_VERSION!r}",
            what_failed=(
                f"ag_meta:schema records version {found!r}, but this version of "
                f"activegraph-surrealdb expects {SCHEMA_VERSION!r}."
            ),
            why=(
                "Reading tables written under a different schema could misread "
                "or drop fields and corrupt the event log."
            ),
            how_to_fix=(
                "Install the adapter version that wrote this database, or migrate "
                "the runs into a fresh database with this version."
            ),
            context={
                "found_version": found,
                "expected_version": SCHEMA_VERSION,
                "driver": "surrealdb",
            },
        )
