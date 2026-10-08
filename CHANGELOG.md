# Changelog

All notable project changes will be documented here.

The project intends to follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and semantic versioning once stable public interfaces exist.

## [Unreleased]

### Changed

- The web prototype now persists to SurrealDB. Accounts and sessions use SurrealDB record access, tenant isolation is enforced by owner-scoped table permissions, and provider OAuth tokens are encrypted by the application before storage. Supabase was removed; a `/login` screen was added because the prototype previously relied on an externally established session.
- Replaced the Postgres migrations in `web/supabase/` with SurrealQL migrations in `web/surreal/migrations/` and a local SurrealDB `compose.yaml`.

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
