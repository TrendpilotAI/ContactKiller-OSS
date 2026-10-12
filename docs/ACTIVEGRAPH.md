# ActiveGraph integration

`activegraph-contactkiller/` is an experimental domain pack that models reconciliation as typed objects, relations, behaviors, tasks, approvals, and replayable events.

## Current scope

- contact source manifests and observations;
- canonical identities and identity proposals;
- deterministic exact email and E.164 phone rules;
- review and approval routing;
- mutation-plan objects without a live provider executor;
- SQLite runtime and optional Postgres support; and
- event replay tests.

## SurrealDB backend package

`packages/activegraph-surrealdb/` is a separate, generic adapter package (`activegraph-surrealdb`, import name `activegraph_surrealdb`). It provides:

- `SurrealEventStore`, an ActiveGraph `EventStore`;
- `SurrealGraphStore`, a durable `GraphStore` projection;
- a shipped SurrealQL schema and an idempotent `apply_schema()`; and
- `open_surreal_store(url, run_id)` for `ws://`, `wss://`, `http://`, `https://`, `mem://`, and `surrealkv://` URLs.

ActiveGraph 1.12 has no store registry, so `open_store()` and `Runtime.load()` cannot open these URLs. Pass the store to `Runtime(graph, store=...)` instead.

The package passes ActiveGraph's `EventStoreConformance` and `GraphStoreConformance` suites unmodified, against a SurrealDB 3.3 server and the embedded engines. Its own tests cover append-before-project ordering, `ConcurrentWriterError` for every writer race, and `PATCH_OPS` enforcement on replay. CI runs all of these against a real server.

The pack does not depend on the adapter, and SQLite remains the pack's default store. Passing conformance does not make SurrealDB the authority for ContactKiller's event history; the acceptance gates in [SurrealDB integration status](SURREALDB.md) still apply. See the package [README](../packages/activegraph-surrealdb/README.md) for setup, URL forms, concurrency and truncation semantics, and limits.

The pack is versioned independently as `0.1.0` and currently pins the supported ActiveGraph runtime in `pyproject.toml`.

## Authority boundary

ActiveGraph describes behavior and event history. It does not own OAuth credentials, browser sessions, provider SDK state, or user authentication. A graph view built from its events is a projection that must remain rebuildable.

## Safe extension points

- new source-observation object types;
- deterministic reconciliation behaviors;
- approval policies;
- task and activity projections;
- alternative event-store adapters (see `packages/activegraph-surrealdb/`); and
- disposable graph projections.

Every extension needs replay and idempotency tests. A behavior that proposes a provider mutation must not execute it directly.
