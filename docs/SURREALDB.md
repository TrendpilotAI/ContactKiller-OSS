# SurrealDB integration status

SurrealDB is the experimental target for a canonical multi-model persistence boundary. It is not the default branch's production authority.

## Why it fits the problem

- document records can preserve exact provider evidence;
- schemafull tables can constrain ownership and lifecycle state;
- graph relations can express observation-to-identity provenance;
- transactions can group manifest, record, event, and relation writes; and
- one query surface can support operations, tasks, and projections without creating a second silent master.

## Current public scope

The sanitized default branch documents the persistence contract but does not ship a SurrealDB store or application cutover. Non-public development work has explored schema, ingestion, and ActiveGraph store adapters; none of that work is a public capability until it is independently reviewed and merged into this repository.

## Acceptance gates

SurrealDB becomes authoritative only after the project proves:

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
