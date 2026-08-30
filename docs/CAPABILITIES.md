# Capability status

This document separates what is implemented on the default branch from experimental feature work and longer-term plans. “Implemented” means code exists and focused tests may exist; it does not imply production proof.

| Capability | Status | Current evidence and limitation |
| --- | --- | --- |
| Contact explorer | Implemented prototype | Supabase-backed list, search, platform badges, counts, and manual Personal/Financial Advisor filters in `web/src/app/contacts/`. |
| Contact CRUD | Implemented prototype | API routes under `web/src/app/api/contacts/`; not production-proven. |
| Conflict review | UI/API scaffold | Manual A/B/skip route exists; current import paths do not supply a complete conflict-generation engine. |
| Google Contacts | Experimental one-way import | Read-only OAuth and paginated People API import. No write-back; expired tokens require reconnect. |
| iCloud | Experimental file import | Manual `.vcf` upload. No CardDAV or native Contacts sync. |
| Deterministic segmentation | Implemented prototype | Hard-coded domain rules and manual bulk tagging. It is not AI classification. |
| Identity matching | Conservative prototype | Import lookup and ActiveGraph exact canonical email/E.164 proposals. No complete fuzzy deduplication engine. |
| Mesh | Implemented research connector | One bounded `searchContacts` call into ignored owner-only local storage. No write-back or continuous sync. |
| Forensic cache | Implemented local tool | DuckDB ingestion, normalization, and summary for disposable analysis. It is not canonical storage. |
| ActiveGraph domain pack | Experimental foundation | Typed objects, tasks, approval routing, event lifecycle, replay tests, SQLite, and optional Postgres support. Not the live application authority. |
| SurrealDB persistence | Active development | Persistence work is not included in the sanitized default branch; application cutover and integrity review are incomplete. |
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
