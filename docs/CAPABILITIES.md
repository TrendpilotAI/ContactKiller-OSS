# Capability status

This document separates what is implemented on the default branch from experimental feature work and longer-term plans. “Implemented” means code exists and focused tests may exist; it does not imply production proof.

| Capability | Status | Current evidence and limitation |
| --- | --- | --- |
| Contact explorer | Implemented prototype | SurrealDB-backed list, search, platform badges, counts, and manual Personal/Financial Advisor filters in `web/src/app/contacts/`. |
| Contact CRUD | Implemented prototype | API routes under `web/src/app/api/contacts/`; not production-proven. |
| Conflict review | UI/API scaffold | Manual A/B/skip route exists; current import paths do not supply a complete conflict-generation engine. |
| Google Contacts | Experimental one-way import | Read-only OAuth and paginated People API import. No write-back. Expired access tokens are refreshed with the stored refresh token (covered by tests with a faked Google endpoint, not verified live); a revoked or unreadable token returns a reconnect prompt. |
| iCloud | Experimental file import | Manual `.vcf` upload. No CardDAV or native Contacts sync. |
| Deterministic segmentation | Implemented prototype | Hard-coded domain rules and manual bulk tagging. It is not AI classification. |
| Identity matching | Conservative prototype | Google import matches only on an existing Google id, a case-insensitive exact email, or a *valid* phone that is equal in E.164 (no last-digits fallback). A match fills empty local fields, files a conflict where a non-empty local value differs, and never changes `is_financial_advisor` or an existing Google link. An email held by several Google contacts is never a match key: each of those contacts is imported as its own new contact (never merged with the others or linked to a local contact by that address), with a `shared_email` conflict filed on each for review and dismissal. A phone shared by several Google contacts is likewise ignored as evidence. Several matching local contacts, a local contact claimed by two Google contacts, or a contact already linked to a different Google id are skipped and reported rather than merged. A provider identity can be linked to at most one contact per user (unique index), and a sync that loses a race to a concurrent sync adopts the contact that won. ActiveGraph proposes exact canonical email/E.164 matches separately. No fuzzy deduplication engine. |
| Mesh | Implemented research connector | One bounded `searchContacts` call into ignored owner-only local storage. No write-back or continuous sync. |
| Forensic cache | Implemented local tool | DuckDB ingestion, normalization, and summary for disposable analysis. It is not canonical storage. |
| ActiveGraph domain pack | Experimental foundation | Typed objects, tasks, approval routing, event lifecycle, replay tests, SQLite, and optional Postgres support. Not the live application authority. |
| Accounts and sessions | Implemented prototype | SurrealDB record access (argon2 passwords, 8-hour tokens) with a `/login` screen and httpOnly session cookie. Sign-up is off by default and gated inside SurrealDB. No password reset, email verification, MFA, or sign-in rate limiting. Sign-out clears the browser cookie only: the SurrealDB JWT is a bearer token that stays valid until it expires, up to 8 hours, so treat a copied cookie as live for that long. |
| SurrealDB persistence | Implemented prototype | `web/surreal/migrations/` defines users, contacts, emails, phones, platform links, conflicts, sync logs, and AES-256-GCM-encrypted OAuth tokens with owner-scoped permissions, covered by tests against a real server. Source observations, field-level provenance, and ActiveGraph replay are not stored; the acceptance gates in `docs/SURREALDB.md` are open. |
| Provider mutations | Planned | A mutation object can be modeled, but no production provider executor exists. |
| HubSpot and Lightfield | Planned connectors | Provider types and generic snapshot concepts exist; no live adapters ship on the default branch. |
| WhatsApp | Evidence source only | No direct WhatsApp contact connector ships. The visible missing-name problem motivates the reconciliation workflow. |
| iOS/macOS native app | Planned | No native project exists in the public tree. |
| AI categorization | Planned | Historical documents claimed this; no implementation exists today. |
| End-to-end encryption | Not implemented | Do not claim zero-knowledge or E2E encryption. |
| FalkorDB projection | Community RFC | No ContactKiller adapter exists today. |

## Status language

- **Implemented prototype:** code exists on the default branch; real-world safety and scale are unproven.
- **Experimental:** code exists in the public tree but is incomplete or is not the current authority.
- **Planned:** design intent only.
- **Community RFC:** deliberately open extension point with no supported implementation.

Update this file in the same pull request whenever a capability changes state.
