# SurrealDB integration status

SurrealDB backs the web prototype's mutable application state and is the experimental target for a canonical multi-model persistence boundary. It is not yet a production authority.

## Why it fits the problem

- document records can preserve exact provider evidence;
- schemafull tables can constrain ownership and lifecycle state;
- graph relations can express observation-to-identity provenance;
- transactions can group manifest, record, event, and relation writes; and
- one query surface can support operations, tasks, and projections without creating a second silent master.

## Current public scope

The web prototype (`web/`) is SurrealDB-only. It replaces the earlier hosted-Postgres persistence layer, which no longer exists in this tree. What ships:

- a record access method for sign-up and sign-in, with argon2 password hashes and a database-side sign-up switch that is off by default;
- schemafull tables for users, contacts, emails, phones, platform links, conflicts, sync logs, and OAuth tokens, each carrying a read-only `owner` and an `owner = $auth` permission clause, with cascade deletes from contacts to their children;
- AES-256-GCM encryption of provider tokens in the application before storage;
- numbered SurrealQL migrations with checksums, transactional apply, and rollback files; and
- tests that run against a real in-memory SurrealDB server.

These tables are mutable application state. Raw source payloads, content hashes, field-level provenance edges, and append-only observations are not implemented in the web prototype.

## ActiveGraph event storage

An ActiveGraph adapter package exists: `packages/activegraph-surrealdb/`. Its contents:

- `SurrealEventStore` keeps the ActiveGraph event log in SCHEMAFULL `ag_*` tables, with unique `(run_id, seq)` and `(run_id, event_id)` indexes.
- `SurrealGraphStore` keeps a rebuildable graph projection.
- Appends and truncation check the run head inside a SurrealQL transaction. A stale writer, or a commit `TransactionConflict`, raises ActiveGraph's `ConcurrentWriterError`.
- `truncate_after` deletes the tail atomically.

The package passes ActiveGraph's upstream `EventStoreConformance` and `GraphStoreConformance` suites unmodified. They run against a SurrealDB 3.3 server in CI and against the SDK's embedded `mem://` and `surrealkv://` engines.

The adapter is not wired into the web prototype or made the default store of the ActiveGraph pack. Passing conformance shows protocol parity. It does not meet the acceptance gates below, in particular replay equivalence with the ContactKiller event history, tenant isolation, and backup and restore. Those gates still have to be met before SurrealDB holds ContactKiller's authoritative event history.

## Acceptance gates

SurrealDB becomes authoritative for provenance and decisions only after the project proves:

1. atomic and truthful manifest completion;
2. exact source-byte preservation and content hashes;
3. field-level provenance edges;
4. no loss of known values during partial sync;
5. deterministic identity-key derivation across every ingestion path;
6. retry idempotency and concurrent-writer safety;
7. tenant isolation at query and mutation boundaries;
8. replay equivalence with the ActiveGraph event history; and
9. backup and restoration from a clean environment.

Green CI or GitHub mergeability does not satisfy these gates on its own.
