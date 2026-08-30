# ContactKiller

**Kill contact chaos. Keep every relationship.**

ContactKiller is an experimental, open-source contact-reconciliation project for people whose address books have become accidental CRMs. The public tree combines a working Supabase prototype, read-only local research tools, and an experimental ActiveGraph domain pack. Its target architecture preserves source evidence, proposes conservative identity matches, and keeps risky provider changes behind explicit human approval; the current web importer does not yet deliver those guarantees end to end.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-3B82F6.svg)](LICENSE)
[![Status: experimental](https://img.shields.io/badge/status-experimental-E5482D.svg)](ROADMAP.md)

[Explore the open-source launch site](https://website-alpha-rose-81.vercel.app)

> [!WARNING]
> ContactKiller is not a production-safe bulk deletion tool. Use synthetic data while developing. Never point an unreviewed build at a real address book or CRM.

## Why this exists

One person can appear as five unrelated records:

- iCloud remembers a name and phone number;
- a personal Google account has an older email;
- a work Google account contains an imported lead card;
- a CRM still classifies the person as a prospect; and
- WhatsApp shows only a number because the phone cannot resolve the right card.

Conventional sync chooses a winner and overwrites the rest. ContactKiller's target workflow treats the address book as a distributed system: capture every observation, keep account boundaries visible, explain how an identity proposal was assembled, and preview cleanup before touching a provider.

## What is different

| Principle | Current public evidence and limitation |
| --- | --- |
| Evidence before mutation | The DuckDB forensic tool records manifests and observations, and the ActiveGraph pack models source evidence. The web prototype still writes mutable contacts directly and does not retain every raw provider observation. |
| Conservative identity | ActiveGraph proposes exact normalized email or E.164 matches. A complete identity engine is not connected to the web prototype. |
| Replayable decisions | The ActiveGraph pack includes event lifecycle and replay tests. The Supabase prototype is not yet a projection of that history. |
| Approval at the boundary | Approval and mutation-plan objects are modeled. No production provider-write executor ships. |
| Account isolation | The prototype records provider links and ContactKiller tenant ownership, but cannot distinguish two accounts from the same provider for one user. Multi-account provenance and full tenant-isolation proof remain acceptance gates. |

## Project status

The repository is intentionally candid about maturity:

| Area | Status | Notes |
| --- | --- | --- |
| Contact explorer and CRUD API | Implemented prototype | Supabase-backed interface and routes; not production-proven. |
| Google Contacts | Experimental | Read-only OAuth scope and one-way import; token refresh and write-back are incomplete. |
| iCloud | Experimental | Manual vCard import; no CardDAV sync. |
| Mesh | Research connector | Bounded, read-only snapshot path into owner-only local storage. |
| ActiveGraph | Experimental foundation | Typed reconciliation objects, approval routing, replay, and runtime tests. Not the live production authority. |
| SurrealDB | Active development | The persistence contract is documented, but no SurrealDB adapter ships in the sanitized default branch. |
| FalkorDB | Community extension | No ContactKiller adapter ships today; disposable projection and benchmark contributions are welcome. |
| Provider mutations | Planned | The data model exists; no production-safe executor is available. |

See [Capabilities](docs/CAPABILITIES.md) and [Integrations](docs/INTEGRATIONS.md) for the detailed matrix.

## Target reconciliation flow

```text
Apple / Google / CRM / Mesh / messaging evidence
                         │
                         ▼
       immutable source observations + manifests
                         │
                         ▼
        normalization with field-level provenance
                         │
                         ▼
          identity proposals and confidence rules
                         │
               ┌─────────┴─────────┐
               ▼                   ▼
         canonical projection   review queue
                                   │
                                   ▼
                         approval-gated change plan
                                   │
                                   ▼
                         bounded provider mutation
```

The public tree does not implement this flow end to end. Today, Google import can update mutable contact fields and iCloud import can skip a duplicate rather than retain a separate source observation. The diagram is an architecture contract and acceptance target, not a production-readiness claim.

The target architecture separates three responsibilities:

- **SurrealDB** is the experimental target for a canonical persistence boundary covering evidence, records, operations, and graph relations.
- **ActiveGraph** supplies typed behavior, tasks, approval routing, event history, replay, and fork/diff experiments.
- **FalkorDB** is a potential disposable projection seam for community experiments—not a second source of truth.

Read [Architecture](docs/ARCHITECTURE.md), [ActiveGraph](docs/ACTIVEGRAPH.md), [SurrealDB](docs/SURREALDB.md), and the [FalkorDB projection RFC](docs/FALKORDB_RFC.md).

## Repository layout

```text
activegraph-contactkiller/   ActiveGraph domain pack and tests
docs/                        Public architecture, safety, and contributor guides
examples/synthetic/          Synthetic contact fixtures and failure cases
scripts/                     Read-only snapshots and disposable forensic tooling
web/                         Next.js reconciliation prototype
website/                     Public open-source launch site
```

## Quick start

### Prerequisites

- [Bun](https://bun.sh/) 1.4 or newer
- Node.js 20.9 or newer
- Python 3.11 or newer for the ActiveGraph pack
- [DuckDB CLI](https://duckdb.org/docs/stable/clients/cli/overview.html) 1.5.5 or newer for the forensic-cache tool and its integration tests
- A development Supabase project or local Supabase stack for the web prototype

### Web prototype

```bash
cd web
cp .env.local.example .env.local
bun install
bun run dev
```

This is a build-and-UI quick start. The example environment file contains placeholders only. To exercise persistence, apply `web/supabase/migrations/001_initial_schema.sql` and then `002_security_and_oauth.sql` to a disposable development Supabase project. To exercise Google import, create a development OAuth web client and register `http://localhost:3000/api/auth/google/callback` (or the matching `NEXT_PUBLIC_APP_URL`) as its redirect URI.

The prototype does not ship a login screen, so authenticated provider routes require a separately established Supabase session. Use synthetic fixtures and a development tenant; do not reuse production credentials or personal contact exports.

### ActiveGraph pack

```bash
cd activegraph-contactkiller
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -e '.[test]'
pytest
```

### Read-only local research tools

```bash
# Plan a bounded Mesh read without contacting the service.
bun scripts/mesh-mcp-snapshot.ts --name "Maya Chen"

# Initialize the ignored, disposable DuckDB forensic cache.
bun scripts/forensic-cache.ts init
bun scripts/forensic-cache.ts summary
```

Mesh execution requires your own authenticated connector. Raw snapshots are written under ignored `.local/` storage with owner-only permissions. They must never be committed or attached to an issue.

## Safety rules for contributors

1. Use only synthetic people, phone numbers, emails, events, and source payloads in public fixtures.
2. Keep adapters read-only by default.
3. Preserve source bytes and provenance before proposing normalization or identity changes.
4. Never merge on names alone.
5. Put every external write behind an explicit approval object and a bounded batch.
6. Include replay, idempotency, tenant-isolation, and rollback tests for persistence changes.

Read [Privacy and data safety](docs/PRIVACY_AND_DATA_SAFETY.md) before opening an issue or pull request.

## Contributing

Useful first contributions include:

- a read-only source adapter;
- a synthetic duplicate or missing-name scenario;
- deterministic normalization and identity rules;
- replay and reconciliation benchmarks;
- graph visualizations;
- a disposable FalkorDB projection; and
- stronger provider-write safety gates.

Start with [CONTRIBUTING.md](CONTRIBUTING.md), the [development guide](docs/DEVELOPMENT.md), and the [testing guide](docs/TESTING.md). Community decisions follow [GOVERNANCE.md](GOVERNANCE.md).

## Security

Do not report vulnerabilities through a public issue. Follow [SECURITY.md](SECURITY.md). Never include real contact exports, OAuth tokens, account identifiers, phone numbers, or customer data in a report.

## License

Copyright 2026 ContactKiller contributors.

Licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) and
[third-party notices](THIRD_PARTY_NOTICES.md) for attribution and dependency-license boundaries.
