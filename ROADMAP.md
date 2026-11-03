# Roadmap

ContactKiller is moving from a personal recovery prototype toward a safe, reusable open-source reconciliation engine. Dates are intentionally omitted until the corresponding safety evidence exists.

## Now — public foundation

- [x] Provenance-first product model
- [x] Experimental contact explorer and conflict-review surface
- [x] SurrealDB-backed web prototype: record-auth accounts with sign-up off by default, owner-scoped tables, encrypted provider tokens, and checksummed migrations
- [x] One-way Google Contacts and iCloud vCard import paths that match on exact identifiers only, never overwrite, and report ambiguous cases
- [x] Bounded, read-only Mesh snapshot tool
- [x] ActiveGraph v0.1 domain pack and replay tests
- [x] Apache-2.0 public documentation and synthetic-data policy
- [x] Publish from a sanitized, allowlisted Git history
- [ ] Replace all personal operational evidence with synthetic fixtures
- [x] Establish branch protection, dependency review, secret scanning, and release checks
- [x] Beads issue tracker with a guarded, scanned public Dolt sync (see [AGENTS.md](AGENTS.md))

## Next — trustworthy persistence

- [ ] Complete SurrealDB repository and schema review
- [ ] Preserve exact source bytes and field-level provenance
- [ ] Make manifest completion atomic and truthful
- [ ] Prove deterministic replay across SQLite, Postgres, and SurrealDB adapters (a SurrealDB backend for ActiveGraph is proposed in [#16](https://github.com/TrendpilotAI/ContactKiller-OSS/pull/16) and is not merged)
- [x] Tenant isolation tests at the database permission layer (`web/tests/`)
- [ ] Restoration from backup in a clean environment
- [x] Remove duplicate-creation races and partial-sync field loss in the web importers (unique provider links, fill-don't-overwrite, conflict-once)
- [ ] Cut application reads to the canonical repository only after acceptance gates pass

## Then — read-only ecosystem

- [ ] Formal provider-adapter SDK and contract tests
- [x] Google access-token refresh from the stored refresh token (tested against a faked Google endpoint)
- [ ] Live verification of Google refresh, and incremental import
- [ ] CardDAV/iCloud read adapter
- [ ] HubSpot read adapter
- [ ] Lightfield read adapter
- [ ] WhatsApp evidence ingestion without pretending to be an address-book API
- [ ] Synthetic conformance suite for missing names, duplicate identities, imports, and account boundaries

## Later — approval-gated change plans

- [ ] Fork/diff simulation for cleanup plans
- [ ] Human-review inbox and explicit approval objects
- [ ] Provider mutation gateway with allowlists and bounded batches
- [ ] Rollback and restoration drills
- [ ] Seven-day sentinel-contact stability monitoring
- [ ] Signed audit exports

## Community exploration

- [ ] Disposable FalkorDB projection adapter
- [ ] Graph-query and replay benchmarks
- [ ] Alternative deterministic identity resolvers
- [ ] Local-first encrypted storage experiments
- [ ] Visualization and explanation plugins

Items in this roadmap are plans, not shipped capabilities. See [docs/CAPABILITIES.md](docs/CAPABILITIES.md) for the current truth.
