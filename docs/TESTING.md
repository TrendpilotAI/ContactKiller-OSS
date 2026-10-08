# Testing guide

ContactKiller tests are organized around data integrity rather than line coverage alone.

## Focused commands

```bash
# TypeScript source tools
bun test scripts/*.test.ts

# Web prototype (persistence tests need a `surreal` binary on PATH or SURREAL_BIN)
cd web
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun test
bun run build

# Public launch site
cd ../website
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run build

# ActiveGraph pack
cd ../activegraph-contactkiller
python -m pip install -e '.[test]'
pytest
```

## Required test classes

### Ingestion

- exhaustive pagination;
- retry idempotency;
- partial-page failure;
- duplicate provider IDs;
- omitted versus explicitly cleared fields; and
- manifest completion only after success.

### Identity

- canonicalized email equality;
- E.164 phone equality;
- names that look similar but represent different people;
- shared family or company phone numbers;
- conflicting source values; and
- no automatic merge from a name alone.

### Persistence and replay

The web prototype's SurrealDB layer is covered by `web/tests/` against a real in-memory server: record auth, owner-scoped permissions, transactional writes, cascade deletes, migration checksums and rollback, ciphertext-only token storage, and importer idempotency. Append-only replay, restoration from backup, and concurrent-writer tests are still open.

- append-only event behavior;
- deterministic replay;
- concurrent writers;
- transaction rollback;
- tenant isolation;
- restoration from backup; and
- projection rebuild from canonical history.

### Provider changes

- dry-run diff;
- explicit approval;
- bounded allowlist;
- duplicate request handling;
- provider partial failure;
- rollback or compensating plan; and
- sentinel-record verification.

## Test data

All committed fixtures must be synthetic. A test that requires a real provider runs privately and reports only a redacted, aggregate result; it does not commit payloads, screenshots, traces, or logs.

## What green CI does not prove

CI does not prove production OAuth, provider rate limits, real-device contact visibility, restoration, deployment provenance, or the safety of a bulk cleanup. Name the exact scope of every verification claim.
