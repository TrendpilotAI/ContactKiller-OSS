# activegraph-surrealdb

A SurrealDB backend for [ActiveGraph](https://github.com/yoheinakajima/activegraph) 1.12:

- `SurrealEventStore` implements ActiveGraph's `EventStore` protocol (`append`,
  `iter_events`, `get_event`, `count`, `truncate_after`, `close`). It also has the
  run-metadata, snapshot, and fork helpers the reference SQLite and Postgres stores
  provide.
- `SurrealGraphStore` implements the `GraphStore` ABC, a durable projection of
  objects, relations, and patches stored in SurrealDB tables.

Both pass ActiveGraph's own conformance suites (`EventStoreConformance` and
`GraphStoreConformance`), unmodified, against a SurrealDB 3.3 server and against
the SDK's embedded `mem://` and `surrealkv://` engines.

The package is experimental (`0.1.0`). It is generic: it has no ContactKiller types
and can back any ActiveGraph application.

## Install

```bash
python -m pip install -e packages/activegraph-surrealdb          # from this repository
python -m pip install -e 'packages/activegraph-surrealdb[test]'  # with the test suite
```

The package pins `activegraph==1.12.0` and `surrealdb==2.0.0` (the Python SDK). The
SDK wheel includes the embedded engines. A server is only needed for `ws://`,
`wss://`, `http://`, and `https://`.

## Run SurrealDB

For local development, start an in-memory server with a throwaway root password:

```bash
surreal start --bind 127.0.0.1:8000 --user root --pass "$(openssl rand -hex 16)" memory
```

Use `rocksdb:<path>` instead of `memory` to keep data. For anything shared, create a
namespace- or database-level user rather than using root. The adapter's user needs
to define tables (unless you apply the schema separately) and to read and write the
`ag_*` tables.

## Use

```python
from activegraph import Runtime
from activegraph.core.graph import Graph
from activegraph_surrealdb import SurrealEventStore, SurrealGraphStore

store = SurrealEventStore(
    "ws://127.0.0.1:8000/rpc", "app", "events", run_id="run_1",
    username="app_user", password=password_from_your_secret_store,
)
graph = Graph(run_id="run_1")                    # in-memory projection, or:
# graph = Graph(run_id="run_1", graph_store=SurrealGraphStore(client, graph_id="run_1"))
runtime = Runtime(graph, store=store)
```

`target` is a URL or a connected `surrealdb.Surreal` client. A client passed in is
borrowed: the adapter never closes it. If you pass `namespace` and `database` with a
client, the adapter switches that client to them. Share one client between an event
store and a graph store to use a single connection. With `mem://` sharing is
required, because every `mem://` connection is a separate empty database.

### URL forms

`open_surreal_store(url, run_id, *, namespace=None, database=None, username=None, password=None)`
opens a store from a URL. These forms are accepted:

| URL | Engine |
| --- | --- |
| `ws://host:8000/rpc`, `wss://host/rpc` | server over WebSocket |
| `http://host:8000`, `https://host` | server over HTTP |
| `mem://` (or `memory`) | embedded, in-process, volatile |
| `surrealkv:///absolute/path` | embedded, on disk (SurrealKV) |

Each form may be prefixed with `surrealdb+` (for example
`surrealdb+wss://db.example.com/rpc`) to mark it as a SurrealDB store URL. Each form
may also carry `?ns=<namespace>&db=<database>` (`namespace` and `database` are
accepted as long names). Keyword arguments override the URL parameters. Credentials
are keyword-only. A URL with `user:pass@` is refused, so secrets do not end up in
logs.

ActiveGraph 1.12's `open_store()` and `Runtime.load()` only dispatch `sqlite` and
`postgres` URLs, and ActiveGraph has no store registry or entry point to extend
them. So a SurrealDB store is passed to `Runtime(graph, store=...)` directly. To
resume a run, replay its log into a fresh graph:

```python
from activegraph.store.base import replay_into

store = open_surreal_store(url, "run_1", username=user, password=password)
graph = Graph(run_id="run_1")
replay_into(graph, store.iter_events())
graph.ids.reseed_from_events(graph.events)
graph.attach_store(store)
runtime = Runtime(graph, store=None)
```

## Schema

`src/activegraph_surrealdb/schema.surql` ships with the package. `apply_schema()`
(called on every store open unless `ensure_schema=False`) defines it with
`IF NOT EXISTS` statements, so it is idempotent. It also records `version = "1"` in
`ag_meta:schema` and raises ActiveGraph's `SchemaVersionMismatch` when an
incompatible version wrote the database. All tables are SCHEMAFULL:

| Table | Purpose |
| --- | --- |
| `ag_run` | `RunRecord` metadata (parent run, fork point, label, goal, frame) |
| `ag_run_head` | per-run head: `head_seq`, `last_seq`, `event_count`, `appended_at` |
| `ag_event` | the log; unique `(run_id, seq)` and `(run_id, event_id)` indexes |
| `ag_snapshot` | compaction snapshot blobs keyed by state hash |
| `ag_object`, `ag_relation`, `ag_patch` | `SurrealGraphStore` projections, scoped by `graph_id` |

Event payloads and projection data are JSON strings. A payload therefore reads back
exactly as ActiveGraph wrote it, with no SurrealDB type coercion. ActiveGraph's
serializer handles canonical values: `Decimal` becomes a string, `date` becomes ISO
8601, and a `set` becomes a sorted list.

## Concurrency semantics

The adapter enforces one logical writer per run, like the reference stores. A
store handle records the run head when it is opened and after each of its own
writes. `append` and `truncate_after` then:

1. re-read the head and raise early if it moved; and
2. run one SurrealQL transaction (`BEGIN ... COMMIT`) that compares the head again
   and `THROW`s on a mismatch, before it writes the event or deletes the tail and
   advances the head.

Three things raise ActiveGraph's `ConcurrentWriterError` with `driver="surrealdb"`
and the expected and actual head and count in `error.context`:

- a mismatch at step 1;
- the `THROW` at step 2;
- a SurrealDB `TransactionConflict` at commit, when two writers raced on the head
  record.

Nothing from the losing writer is committed. The handle is not updated either, so
retrying it fails again. Reload the run and coordinate a single writer instead.

The head token is the last retained `seq`. The compare also checks `last_seq`, the
highest seq ever allocated, which never decreases. So "append, then truncate back to
the same seq" by another writer still counts as a moved head.

A duplicate event id in a run raises `DuplicateEventError` (from the unique index).

If the connection drops while a commit is in flight, the outcome is unknown and the
adapter raises the underlying error. If the commit did land, the handle's next write
raises `ConcurrentWriterError`, so a stale handle never writes over it.

## Truncation

`truncate_after(event_id)` deletes every event after `event_id`, all in one
transaction with the head check. Those rows are gone; there is no archive copy. An
unknown id raises `EventNotFoundError` and deletes nothing.

## GraphStore notes

`SurrealGraphStore(target, namespace=None, database=None, *, graph_id="default")`
keeps one projection per `graph_id`. `find_objects` and `find_relations` filter in
the database. The other query hooks (`query_objects`, `neighborhood`,
`match_chain`, ...) use ActiveGraph's base-class implementations. `clear()` deletes
the projection in one transaction.

ActiveGraph appends each event before it projects it. With both stores in
SurrealDB, those are still two separate writes. If a projection write fails, the
event is already durable, and replaying the log into an empty projection rebuilds
it. Treat the projection as rebuildable, never as a source of truth.

## Limits and differences from the reference stores

- No archive tier: `archive_prefix`, `archive_run`, `iter_archived`, and
  `has_archived` are not implemented. ActiveGraph's compaction and retention
  (`activegraph.store.retention`) and `Runtime.fork` / `promote` require a
  `SQLiteEventStore` and do not call them on other stores.
- `fork_run`, `list_runs`, and `most_recent_run_id` are classmethods taking a target
  (and optional namespace, database, and credentials), like Postgres. `fork_run`
  keeps the parent's `seq` values and raises `ValueError` if the new run exists.
  `most_recent_run_id` orders by the server's `appended_at` time.
- A handle is not thread-safe. ActiveGraph's `Graph` serializes its own appends; use
  one handle per writer thread.
- `iter_events` reads in pages (`page_size`, default 1000). A concurrent truncate
  between pages can shorten an iteration that is already running.
- Embedded engines: the SDK's embedded engine reports `surrealdb-2.0.0`, not the 3.x
  server version, and its errors carry no kind. The adapter classifies errors by
  message markers and index names, so both engines behave the same. SurrealKV is
  labelled beta upstream.

## Running the tests

```bash
cd packages/activegraph-surrealdb
python -m pip install -e '.[test]'
python -m pytest -rs                     # embedded mem:// and surrealkv:// only

ACTIVEGRAPH_SURREALDB_TEST_URL=ws://127.0.0.1:8000/rpc \
ACTIVEGRAPH_SURREALDB_TEST_USER=root \
ACTIVEGRAPH_SURREALDB_TEST_PASS="$SURREAL_PASS" \
python -m pytest -rs                     # adds the server (ws and http)
```

Every test uses a fresh random namespace and database and removes it afterwards.
The suite has three parts:

- the upstream conformance suites, one class per target;
- explicit tests for append-before-project ordering, `ConcurrentWriterError` in
  each race (including a real multi-connection race on a server), and `PATCH_OPS`
  enforcement on replay;
- a Runtime patch-history round trip.

Without `ACTIVEGRAPH_SURREALDB_TEST_URL`, the explicit tests run on embedded
`mem://` and the server cases are skipped with a reason.

## License

Apache License 2.0. See `LICENSE` and `NOTICE`.
