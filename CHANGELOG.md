# Changelog

All notable project changes will be documented here.

The project intends to follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and semantic versioning once stable public interfaces exist.

## [Unreleased]

### Changed

- The web prototype now persists to SurrealDB. Accounts and sessions use SurrealDB record access, tenant isolation is enforced by owner-scoped table permissions, and provider OAuth tokens are encrypted by the application before storage. Supabase was removed; a `/login` screen was added because the prototype previously relied on an externally established session.
- Replaced the Postgres migrations in `web/supabase/` with SurrealQL migrations in `web/surreal/migrations/` and a local SurrealDB `compose.yaml`.
- Google import now matches only on exact identifiers and never overwrites: it fills empty fields, files conflicts for differences, leaves `is_financial_advisor` and existing Google links alone, and skips ambiguous matches.
- Google sync refreshes expired access tokens from the stored refresh token.
- Sign-up is off by default and enforced by the database (rolling the gate back leaves it closed); every state-changing route checks the request origin, and JSON bodies are size-capped.
- iCloud import follows the Google rules: it matches on the vCard UID, exact email or valid phone, fills empty fields, files conflicts instead of overwriting, imports contacts that share an email separately, and reports every card as created, matched, skipped, or errored. A failed sign-up now gives the same generic message for every cause.
- Phone matching includes the extension, rejects values that are not just a number, and a card whose id points at one contact but whose email or phone point at another is skipped. Cards without a UID no longer store a throwaway link.
- iCloud phone values are no longer reduced to digits before matching (which could turn "867-5309 x201" or "Office: 201-555-0123" into another person's number); the raw value is stored and matched. Phone values already imported by an earlier version were stored in the reduced form and are not migrated, which is acceptable because this repository only holds prototype data.
- UID-less cards that cannot be told apart from an earlier import are skipped and reported instead of duplicated, and never merge into a contact that already has a provider link. Google's `canonicalForm` is preferred when building phone keys.
- A provider identity is unique per user. Google contacts that share an email are imported separately and flagged for review rather than skipped or merged.

### Fixed

- vCard import now reads property values instead of whole property lines and accepts LF line endings.
- Conflict resolution only applies a fixed set of contact columns, and the conflict view reads the stored source labels.

## [0.1.0] - 2026-08-30

### Added

- Apache License 2.0 and public governance documents.
- Public capability, architecture, integration, privacy, development, and testing guides.
- Synthetic-data contribution boundary and issue templates.
- Open-source product website.

### Changed

- Reframed the project as experimental, evidence-first reconciliation rather than a completed bidirectional-sync platform.
- Separated implemented, experimental, and planned capabilities.

### Removed

- Private operational audit content and competitor research from the public release snapshot.

### Security

- The public release is built from an exact allowlisted snapshot in a new root history; internal refs and private source data are excluded.
