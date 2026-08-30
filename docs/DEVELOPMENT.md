# Development guide

## Toolchain

- Bun 1.4+ for TypeScript dependencies, scripts, and tests
- Node.js 20.9+ for Next.js
- Python 3.11+ for the ActiveGraph pack
- DuckDB CLI 1.5.5+ for the local forensic-cache tool and its integration tests
- Supabase for the current web prototype

## Clean setup

```bash
git clone https://github.com/TrendpilotAI/ContactKiller-OSS.git
cd ContactKiller-OSS

cd web
cp .env.local.example .env.local
bun install
bun run dev
```

The command above starts the interface but does not provision its backend. For a disposable development environment:

1. Apply `web/supabase/migrations/001_initial_schema.sql` and then `002_security_and_oauth.sql` to a development Supabase project.
2. Copy only that project's URL and anonymous key into `.env.local`.
3. For Google import, create a development OAuth web client and register `${NEXT_PUBLIC_APP_URL}/api/auth/google/callback` as an authorized redirect URI.
4. Establish a Supabase user session separately; the current prototype does not ship a login screen.

Provider routes are therefore experimental integration surfaces, not a one-command end-to-end demo.

## Environment variables

`web/.env.local.example` is the authority for the prototype. Values must point to a development tenant. Do not commit `.env`, `.env.local`, exported shell state, provider credentials, or deployment tokens.

## Local data

Ignored research artifacts live under `.local/contactkiller/`. Delete them according to your own retention policy; Git ignore rules are not a data-lifecycle tool.

## Code conventions

- TypeScript is strict and uses ES modules where the surrounding package supports them.
- Prefer interfaces for public object shapes and `async`/`await` for asynchronous flow.
- Provider reads must be paginated, bounded, idempotent, and account-scoped.
- Preserve exact observations; normalization produces derived values.
- Python code uses type hints, dataclasses or Pydantic models, and `pathlib` for paths.
- New public behavior includes synthetic tests and status-document updates.

## Adding an adapter

1. Write a short proposal that names scopes, pagination, stable IDs, rate limits, and source evidence.
2. Add a synthetic provider fixture.
3. Implement read-only ingestion behind an explicit adapter interface.
4. Prove idempotency and partial-failure behavior.
5. Record manifest completion only after every page succeeds.
6. Add the provider to `docs/INTEGRATIONS.md` as experimental.

Do not include provider writes in the first adapter pull request.

## Database work

Schema changes require migration, rollback, tenant-isolation tests, replay impact, and an explanation of which store is authoritative. Never make a projection the only copy of source evidence or decisions.
