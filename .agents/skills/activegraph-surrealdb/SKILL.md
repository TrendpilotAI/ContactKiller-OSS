---
name: activegraph-surrealdb
description: Use when an ActiveGraph application should keep its event log or graph projection in SurrealDB, or when working on packages/activegraph-surrealdb. Trigger when the user asks to install or configure the SurrealDB backend, open a SurrealDB store URL, apply its schema, run the conformance suites against a SurrealDB server or embedded engine, or debug ConcurrentWriterError, DuplicateEventError, or schema-version errors from it.
---

# ActiveGraph SurrealDB backend

`packages/activegraph-surrealdb` (import `activegraph_surrealdb`) provides two stores:

- `SurrealEventStore`, an ActiveGraph 1.12 `EventStore`;
- `SurrealGraphStore`, a `GraphStore` projection.

Both pass ActiveGraph's upstream conformance suites unmodified. The package README is the reference; this skill is the short path.

## When To Use It

- An ActiveGraph run needs a durable log in SurrealDB instead of SQLite or Postgres.
- A rebuildable graph projection should live in SurrealDB tables.
- You changed the adapter and need to prove protocol parity.

SQLite remains the default for ActiveGraph and for the ContactKiller pack. Do not describe the adapter as ContactKiller's authoritative event history; `docs/SURREALDB.md` lists the gates that are still open.

## Install

```bash
cd packages/activegraph-surrealdb
python3.11 -m venv .venv && . .venv/bin/activate
python -m pip install -e '.[test]'
```

The package pins `activegraph==1.12.0` and `surrealdb==2.0.0`. The embedded `mem://` and `surrealkv://` engines come with the SDK wheel; no server is needed for them.

## Run SurrealDB

Start a local server with a fresh throwaway password. Never reuse a real one, and keep the port on loopback:

```bash
export SURREAL_PASS="$(openssl rand -hex 16)"
surreal start --bind 127.0.0.1:8000 --user root --pass "$SURREAL_PASS" memory &
curl --fail --silent http://127.0.0.1:8000/health
```

## Configure

```python
import os

from activegraph import Runtime
from activegraph.core.graph import Graph
from activegraph_surrealdb import SurrealEventStore, open_surreal_store

store = SurrealEventStore("ws://127.0.0.1:8000/rpc", "app", "events", run_id="run_1",
                          username="root", password=os.environ["SURREAL_PASS"])
# or: open_surreal_store("surrealdb+ws://127.0.0.1:8000/rpc?ns=app&db=events", "run_1", username=..., password=...)
runtime = Runtime(Graph(run_id="run_1"), store=store)
```

- URLs: `ws://`, `wss://`, `http://`, `https://`, `mem://`, `surrealkv:///abs/path`. Any of them can take a `surrealdb+` prefix and `?ns=..&db=..`.
- Credentials are keyword arguments only. A URL with `user:pass@` is refused.
- To share a connection, pass a connected `surrealdb.Surreal` client instead of a URL. The adapter borrows it and never closes it. With `mem://` this is required, because each `mem://` connection is a separate database.

## Apply The Schema

Store constructors call `apply_schema()` automatically. It is idempotent (`DEFINE ... IF NOT EXISTS`) and records schema version `1` in `ag_meta:schema`. If the configured user may not define tables, have an owner run it once, then open stores with `ensure_schema=False`:

```python
from activegraph_surrealdb import apply_schema
apply_schema("ws://127.0.0.1:8000/rpc", namespace="app", database="events", username=..., password=...)
```

The SurrealQL lives in `src/activegraph_surrealdb/schema.surql`. To change a definition, bump `SCHEMA_VERSION`; existing `DEFINE ... IF NOT EXISTS` statements never alter a table that already exists.

## Run Conformance

```bash
cd packages/activegraph-surrealdb
python -m pytest -rs        # embedded mem:// and surrealkv:// (server cases skip with a reason)
ACTIVEGRAPH_SURREALDB_TEST_URL=ws://127.0.0.1:8000/rpc \
ACTIVEGRAPH_SURREALDB_TEST_USER=root ACTIVEGRAPH_SURREALDB_TEST_PASS="$SURREAL_PASS" \
python -m pytest -rs        # adds the server, over ws and http
```

Never edit, skip, or override upstream conformance test methods to get a green run. Fix the adapter instead. CI runs the same suite in the "SurrealDB ActiveGraph adapter" job.

## Pitfalls

- `open_store()` and `Runtime.load()` in ActiveGraph 1.12 only open `sqlite` and `postgres` URLs. Pass the store to `Runtime(graph, store=...)`; to resume, follow the replay pattern in the README.
- `ConcurrentWriterError` means another handle moved the run head. Do not catch it and retry on the same handle; close it, reload the run, and keep one writer per run.
- `DuplicateEventError` means the event id already exists in that run. Use ActiveGraph's id generator.
- `truncate_after` deletes the tail for good; there is no archive tier.
- Compaction and retention (`activegraph.store.retention`) and `Runtime.fork`/`promote` are SQLite-only upstream.
- The projection is two writes after the event, not one transaction with it. Rebuild a broken projection by replaying the log into an empty `SurrealGraphStore` (`clear()` first or use a new `graph_id`).
- The embedded engine reports version `surrealdb-2.0.0` and attaches no error kinds. Keep error classification on the message markers and index names in `event_store.py`.
- Store handles are not thread-safe. Use one per writer.
- Never paste server passwords into tickets, docs, or test output. The test support code keeps the password out of reprs.
