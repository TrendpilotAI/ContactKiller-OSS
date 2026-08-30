# Contributing to ContactKiller

Thank you for helping make contact reconciliation safer, more explainable, and easier to extend.

## Start with the safety boundary

Contact data is personal data. Public contributions must use synthetic fixtures only.

Do not put any of the following in code, tests, issues, pull requests, screenshots, logs, or recordings:

- real names paired with real contact details;
- contact exports or raw provider payloads;
- OAuth tokens, cookies, API keys, tenant IDs, or account identifiers;
- private messages, calendar events, CRM notes, or relationship history; or
- customer, employer, or prospect datasets.

If a bug requires sensitive evidence, follow [SECURITY.md](SECURITY.md) and share the minimum information through a private channel.

## Good first contributions

- Add a synthetic failure case under `examples/synthetic/`.
- Improve deterministic normalization or identity rules.
- Add a read-only provider adapter with fixtures and contract tests.
- Strengthen replay, idempotency, restoration, or tenant-isolation tests.
- Build a graph visualization or disposable FalkorDB projection.
- Clarify architecture, safety, or provider limitations in the docs.

## Development setup

The repository contains four independently testable surfaces:

```bash
# Next.js reconciliation prototype
cd web
cp .env.local.example .env.local
bun install
bun run lint
bun run build

# Public launch site
cd ../website
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run build

# Source snapshot and forensic-cache tooling
cd ..
bun test scripts/*.test.ts

# ActiveGraph domain pack
cd activegraph-contactkiller
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -e '.[test]'
pytest
```

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) and [docs/TESTING.md](docs/TESTING.md) for details.

## Before opening a pull request

1. Search existing issues and pull requests.
2. Open a proposal first for new provider writes, identity heuristics, persistence boundaries, or schema changes.
3. Keep the change small enough to review and replay.
4. Add synthetic fixtures for every new behavior and failure mode.
5. Run the focused tests, lint, and build affected by the change.
6. Update the capability or integration status when behavior changes.
7. Complete the privacy checklist in the pull-request template.

## Design rules for adapters

- Read-only is the default.
- Preserve exact source bytes where the provider permits it.
- Record source, account alias, provider record ID, capture time, and content hash.
- Normalize into derived fields without erasing the original observation.
- Make ingestion idempotent and explicitly handle pagination and partial failure.
- Never infer identity from a name alone.
- Route every external mutation through an approval object and a bounded executor.

## Review and merge

Maintainers review for product truth, data integrity, safety, tests, documentation, and maintainability. Green CI is necessary but does not by itself prove a provider workflow is safe. Changes that affect real external writes require explicit restoration and sentinel-record evidence before release.

By submitting a contribution, you agree that it is licensed under the Apache License 2.0 as described in [LICENSE](LICENSE).

Project governance is documented in [GOVERNANCE.md](GOVERNANCE.md). Community behavior is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
