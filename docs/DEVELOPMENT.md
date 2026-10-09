# Development guide

## Toolchain

- Bun 1.4+ for TypeScript dependencies, scripts, and tests
- Node.js 20.9+ for Next.js
- Python 3.11+ for the ActiveGraph pack
- DuckDB CLI 1.5.5+ for the local forensic-cache tool and its integration tests
- Docker (or a SurrealDB 3.x server binary) for the web prototype's database

## Clean setup

```bash
git clone https://github.com/TrendpilotAI/ContactKiller-OSS.git
cd ContactKiller-OSS

cd web
cp .env.local.example .env.local
cp compose.env.example compose.env
bun install
# start the local database and apply the schema (see below), then:
bun run dev
```

Use this public repository for development; the private internal archive is not a contributor source.

The commands above start the interface but do not provision its database. For a disposable local environment:

1. Copy `web/compose.env.example` to `web/compose.env` (git-ignored) and set a local SurrealDB root password.
2. Start SurrealDB: `docker compose --env-file compose.env up -d --wait`. The container is pinned to a SurrealDB release, stores data in a named volume, and binds `127.0.0.1:8000` only.
3. Set `CONTACTKILLER_TOKEN_ENCRYPTION_KEY` in `.env.local` to the output of `openssl rand -base64 32`.
4. Apply the schema: `bun run db:migrate`. It creates the namespace and database named in `.env.local`, applies each `web/surreal/migrations/*.surql` file in one transaction together with its bookkeeping row, refuses to re-run a file whose contents changed, and is safe to repeat. Files are hashed in LF form, and may not contain their own `BEGIN`/`COMMIT`/`CANCEL`. `bun run db:rollback -- --confirm` (or `CONTACTKILLER_CONFIRM_ROLLBACK=yes`) undoes the latest migration using its `.down.surql` file; it refuses without confirmation, and when the up file on disk no longer matches the checksum recorded when it was applied. Only up files are checksummed; a down file is read as written at rollback time, so editing one is safe. Rollbacks drop schema and data. They never reopen sign-up: the down file for the sign-up gate leaves the `account` SIGNUP clause refusing everyone (`signup_disabled`) until the migration is applied again. Migration `0003` (unique `(owner, platform, platform_id)` platform links) stops with instructions if duplicates already exist, `0004` makes a duplicate email an explicit internal `email_taken` error (never shown to clients), `0005` makes each recorded disagreement unique per `(owner, contact, field, value_a, value_b)` (with the same duplicate precheck and instructions), `0006` makes a duplicate sign-up spend the same argon2 work as a real one, and `0007` stores each phone's match key (`phone_key`) next to its raw text, with an event that clears the key when the raw text is edited without a new key.
5. Create your first account. Sign-up is off by default and enforced in the database: the `account` SIGNUP clause throws `signup_disabled` unless the row `setting:signup` has `enabled = true`, so connecting to SurrealDB directly does not bypass it. `bun run db:migrate` sets that row from `CONTACTKILLER_ALLOW_SIGNUP` every time it runs. To bootstrap: set the variable to `true` in `.env.local`, run `bun run db:migrate`, restart `bun run dev`, create the account at `/login`, then set it back to `false` and run `bun run db:migrate` again. The app also reads the variable to hide the sign-up form, but the database setting is what is enforced.
6. For Google import, create a development OAuth web client and register `${NEXT_PUBLIC_APP_URL}/api/auth/google/callback` as an authorized redirect URI.

Provider routes are experimental integration surfaces, not a one-command end-to-end demo.

If you already run SurrealDB elsewhere, point `SURREALDB_URL`, `SURREALDB_NAMESPACE`, and `SURREALDB_DATABASE` at it and give `compose.env` credentials that may create a namespace and database. Reset local data with `docker compose --env-file compose.env down -v`.

### Web tests

`bun test` in `web/` runs unit tests and integration tests for the persistence layer. The integration tests start a throwaway in-memory SurrealDB server on a random port, apply the real migrations, and exercise authentication, tenant isolation, contact CRUD, cascades, conflicts, encrypted token storage, and the Google and vCard importers with synthetic data. They need a SurrealDB server binary: put `surreal` on `PATH` or set `SURREAL_BIN`. Without one they are skipped locally and fail under `CI=true`.

### How persistence is wired

- **Accounts and sessions.** `web/surreal/migrations/` defines a record access method named `account` (argon2 password hashes, 8-hour tokens, password length bounded on sign-in, an argon2 hash spent for unknown emails so timing does not reveal which addresses are registered). `/api/auth/signup` and `/api/auth/signin` exchange credentials for a SurrealDB token that is stored in an httpOnly `ck_session` cookie. Every request opens a connection authenticated with that token, so SurrealDB applies the table permissions for that user.
- **Ownership.** Each user-owned table has a read-only `owner` field and a `PERMISSIONS ... WHERE owner = $auth` clause; child rows can only be created under the owner's own contact. SurrealDB reports a denied `CREATE` as an empty result rather than an error, so repository code and tests check what was stored.
- **Provider tokens.** Google tokens are encrypted with AES-256-GCM in `web/src/lib/db/crypto.ts` before they are written, bound to their owner and provider. The database only holds ciphertext. Losing or rotating the key means reconnecting providers.
- **Browser requests.** Every POST/PATCH/DELETE route checks `Origin` (falling back to `Referer`) against `NEXT_PUBLIC_APP_URL` and refuses requests with neither; JSON routes require `Content-Type: application/json` and read at most 8 KB (sign-in/up), 16 KB (PATCH) or 256 KB (other JSON), answering 413 from `Content-Length` or after cutting the stream off at the cap. Uploads are streamed with a 10 MB cap and are only read after the session is verified.
- **Provider matching.** Google and iCloud imports run through one policy (`web/src/lib/sync/reconcile.ts`): exact identifiers only (provider id, case-insensitive email, valid E.164 phone), fill-don't-overwrite, conflicts for differences, ambiguous cases skipped and reported, shared emails never a match key. Attaching a provider link is checked inside the merge transaction, so a link claimed by another contact in the meantime cancels the merge instead of touching that contact's row. See `docs/CAPABILITIES.md`.
- **Root credentials** (`SURREALDB_ROOT_USER`/`SURREALDB_ROOT_PASSWORD`) are read only by `bun run db:migrate` and the test harness, never by the Next.js runtime.

## Environment variables

`web/.env.local.example` is the authority for the prototype's runtime settings and `web/compose.env.example` for local database provisioning. The root password in `compose.env.example` is intentionally empty; `docker compose` refuses to start SurrealDB until you set one, and `db:migrate` rejects an empty or `replace-with…` placeholder. Values must point to a development database. Do not commit `.env`, `.env.local`, exported shell state, provider credentials, or deployment tokens.

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

Schema changes require a new numbered migration (never edit an applied one) with a matching `.down.surql` rollback, tenant-isolation tests, replay impact, and an explanation of which store is authoritative. Never make a projection the only copy of source evidence or decisions.
