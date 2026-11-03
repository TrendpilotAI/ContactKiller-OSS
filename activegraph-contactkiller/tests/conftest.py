"""Event-store backend selection for the replay tests.

By default the tests use a throwaway SQLite file. Set
``CONTACTKILLER_TEST_POSTGRES_URL`` to an administrative PostgreSQL URL (a role
that may ``CREATE DATABASE``) to run the same tests against Postgres; every
test then gets its own freshly created database, dropped afterwards.
"""

from __future__ import annotations

import os
import sqlite3
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import pytest
from activegraph.store import parse_store_url

try:
    import psycopg
    from psycopg import sql
except ImportError:  # the postgres extra is optional
    psycopg = None
    sql = None

POSTGRES_URL_ENV = "CONTACTKILLER_TEST_POSTGRES_URL"


@dataclass(frozen=True)
class EventStoreTarget:
    url: str
    backend: str

    def delete_run_metadata(self, run_id: str) -> None:
        """Remove a run's metadata row but keep its events (corruption setup)."""

        if self.backend == "sqlite":
            with sqlite3.connect(parse_store_url(self.url).sqlite_path) as connection:
                connection.execute("DELETE FROM runs WHERE run_id = ?", (run_id,))
            return
        with psycopg.connect(self.url, autocommit=True) as connection:
            connection.execute("DELETE FROM runs WHERE run_id = %s", (run_id,))


def _with_database(url: str, database: str) -> str:
    parts = urlsplit(url)
    return urlunsplit(parts._replace(path=f"/{database}"))


@pytest.fixture
def event_store(tmp_path: Path) -> Iterator[EventStoreTarget]:
    admin_url = os.environ.get(POSTGRES_URL_ENV)
    if not admin_url:
        yield EventStoreTarget(
            url=f"sqlite:///{tmp_path / 'contactkiller-events.sqlite'}",
            backend="sqlite",
        )
        return

    if psycopg is None:
        pytest.fail(f"{POSTGRES_URL_ENV} is set but psycopg is not installed")
    database = f"ck_test_{uuid.uuid4().hex[:12]}"
    with psycopg.connect(admin_url, autocommit=True) as admin:
        admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database)))
    try:
        yield EventStoreTarget(url=_with_database(admin_url, database), backend="postgres")
    finally:
        with psycopg.connect(admin_url, autocommit=True) as admin:
            admin.execute(
                sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(
                    sql.Identifier(database)
                )
            )
