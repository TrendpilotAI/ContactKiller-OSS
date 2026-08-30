# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- People whose personal address books have become accidental CRMs across Apple, Google, messaging apps, and sales systems.
- Operators separating active relationships from years of legacy lead data without losing important personal contacts.
- Developers and data-quality practitioners exploring provenance-aware identity resolution, event replay, and graph projections.
- Open-source contributors from the SurrealDB, ActiveGraph, and FalkorDB communities.

## Product Purpose

ContactKiller aims to turn contradictory contact records into traceable identity proposals. Its acceptance target is to preserve source evidence, keep account boundaries visible, and let a human review cleanup decisions before a provider is changed. Success means fewer fragmented or duplicate identities without silent data loss, destructive bulk cleanup, or a new opaque contact silo.

## Positioning

ContactKiller is reconciliation, not indiscriminate synchronization. Its distinguishing design goal is a provenance-first, append-only decision history: observations remain attributable to their source; canonical views are replayable projections; and risky merges, deletions, or publications remain approval-gated. The ActiveGraph pack exercises parts of this model; the web prototype does not yet enforce it end to end.

## Operating Context

The product is evaluated against fragmented iCloud and Google address books, CRM records, messaging evidence, and enriched relationship systems. The safe workflow is capture, normalize, propose, simulate, review, apply in a bounded batch, and verify. Public examples and fixtures must be synthetic.

## Capabilities and Constraints

- The current prototype includes a Next.js contact/conflict interface, Google Contacts import routes, iCloud vCard import, provider links with ContactKiller tenant ownership, a Mesh read-only snapshot path, and an experimental ActiveGraph domain pack. It does not yet preserve separate personal and work accounts from the same provider.
- SurrealDB is a documented persistence target; no adapter ships in the sanitized default branch and it is not the production authority.
- FalkorDB is a community exploration track for disposable graph projections, not a current runtime dependency or second source of truth.
- Provider-write safety, tenant isolation, complete adapter coverage, restoration proof, and production cutover remain incomplete.
- ContactKiller is experimental software and must not be presented as a production-safe bulk deletion tool.
- The public repository is licensed under Apache License 2.0.

## Brand Commitments

- Name: ContactKiller.
- Public promise: “Kill contact chaos. Keep every relationship.”
- Voice: forensic but humane, technically precise, candid about limitations, and lightly irreverent.
- Never claim an opaque “AI-powered single source of truth,” unsupported performance metrics, fake customer proof, or production readiness.
- Clearly separate current, experimental, and planned capabilities.

## Evidence on Hand

- Existing implementation and test files in `web/`, `scripts/`, and `activegraph-contactkiller/`.
- Public status and limitations in `README.md`, `docs/CAPABILITIES.md`, `docs/ARCHITECTURE.md`, and `ROADMAP.md`.
- The sanitized public tree deliberately excludes private audits, research bundles, source exports, and operational evidence; none are public product proof.
- No public testimonials, customer logos, production benchmarks, or independently verified deletion-safety claims exist.

## Product Principles

1. Preserve source evidence before deciding.
2. Resolve identities conservatively and explain every proposal.
3. Simulate risky cleanup before touching a provider.
4. Keep human approval at the mutation boundary.
5. Make projections disposable and the decision history replayable.

## Accessibility & Inclusion

The public web experience should meet WCAG 2.2 AA expectations, preserve keyboard navigation and focus visibility, respect reduced-motion preferences, and explain graph concepts without requiring graph-database expertise.
