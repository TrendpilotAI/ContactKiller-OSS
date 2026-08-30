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

The pack is versioned independently as `0.1.0` and currently pins the supported ActiveGraph runtime in `pyproject.toml`.

## Authority boundary

ActiveGraph describes behavior and event history. It does not own OAuth credentials, browser sessions, provider SDK state, or user authentication. A graph view built from its events is a projection that must remain rebuildable.

## Safe extension points

- new source-observation object types;
- deterministic reconciliation behaviors;
- approval policies;
- task and activity projections;
- alternative event-store adapters; and
- disposable graph projections.

Every extension needs replay and idempotency tests. A behavior that proposes a provider mutation must not execute it directly.
