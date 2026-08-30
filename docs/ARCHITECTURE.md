# Architecture

ContactKiller is designed around one boundary: source systems remain evidence, while canonical contacts become replayable projections of reviewed decisions. This is the target architecture; the current public web prototype has not completed that cutover.

## Data flow

```text
┌──────────────────────────────────────────────────────────────┐
│ iCloud · Google accounts · CRMs · Mesh · messaging evidence │
└──────────────────────────────┬───────────────────────────────┘
                               │ read-only adapters
                               ▼
┌──────────────────────────────────────────────────────────────┐
│ Source manifest + exact observation + account provenance    │
└──────────────────────────────┬───────────────────────────────┘
                               │ deterministic derivation
                               ▼
┌──────────────────────────────────────────────────────────────┐
│ Normalized email/phone fields + candidate identity links    │
└──────────────────────────────┬───────────────────────────────┘
                               │ tasks and policies
                               ▼
┌──────────────────────────────────────────────────────────────┐
│ Proposed resolution + explanation + confidence + review     │
└──────────────────┬──────────────────────────┬────────────────┘
                   │ approved                │ rejected/deferred
                   ▼                         ▼
┌─────────────────────────────┐    ┌───────────────────────────┐
│ Replayable canonical graph  │    │ Preserved source evidence │
└──────────────────┬──────────┘    └───────────────────────────┘
                   │ explicit bounded plan
                   ▼
┌──────────────────────────────────────────────────────────────┐
│ Provider mutation gateway: simulate → approve → apply       │
└──────────────────────────────────────────────────────────────┘
```

## Current default-branch implementation

- The Next.js prototype uses Supabase for mutable contacts, source/account labels, OAuth configuration, and conflicts. It does not preserve exact raw source payloads or append-only observations for every import.
- Google import can update an existing contact's mutable fields. iCloud import can treat a matching record as a duplicate and skip it. These paths are one-way prototype importers, not evidence-preserving reconciliation.
- The local DuckDB cache supports rebuildable research joins and summaries.
- The ActiveGraph pack models manifests, observations, canonical identities, proposals, tasks, approvals, and events independently of the web application.
- No production provider-mutation gateway exists.

## Target persistence boundary

SurrealDB is being evaluated as the canonical multi-model store for:

- source manifests and exact payload evidence;
- normalized records and account ownership;
- operations, tasks, approvals, and activities;
- canonical identities and provenance relations; and
- replay-derived graph projections.

That cutover is incomplete. Until acceptance gates pass, the target design must not be described as the production source of truth.

## ActiveGraph boundary

ActiveGraph owns behavior and replay semantics, not authentication or provider credentials. The pack should remain portable across event stores and graph-projection implementations.

## Projection rule

A graph projection is disposable. It must be reproducible from the event history and source observations, and deleting or rebuilding it must not erase provenance or decisions. This is the boundary for a future FalkorDB adapter.

## Target invariants

These are acceptance gates for the canonical system, not guarantees of the current Supabase prototype.

1. A source observation is never silently rewritten by normalization.
2. Account ownership is explicit on every source record.
3. Names alone never create an automatic identity link.
4. A manifest cannot be complete if any page or record failed.
5. A repeated ingestion is idempotent.
6. An omitted field in a partial sync does not erase a known value.
7. External writes require a reviewed plan, bounded target set, and rollback evidence.
8. A canonical identity can explain which observations and decisions produced it.

## Trust boundaries

Provider APIs, MCP servers, imported files, browser sessions, and generated enrichment are untrusted inputs. Validate them at ingestion, retain raw evidence where lawful, and keep credentials outside the event graph.
