# Integration matrix

Every provider is described on four axes: read, write, provenance, and proof. A checkmark means an implementation exists on the default branch; it does not imply production readiness.

| Integration | Read/import | Write/export | Provenance | Status |
| --- | --- | --- | --- | --- |
| Google Contacts | Experimental one-way People API import | No | Provider IDs and ContactKiller user ownership in prototype | Multiple Google accounts per user, token refresh, incremental sync, and production proof incomplete |
| iCloud / Apple Contacts | Manual vCard upload | No | Import source recorded in prototype | No CardDAV or native Contacts adapter |
| Mesh | Bounded `searchContacts` snapshot | No | Exact result stored in ignored owner-only local snapshot | Research-only; no continuous sync |
| HubSpot | No live adapter | No | Provider type/design only | Planned read-only adapter |
| Lightfield | No live adapter | No | Provider type/design only | Planned read-only adapter |
| WhatsApp | No direct connector | No | Manual/Mesh evidence only | Missing-name evidence source, not an address-book API |
| Supabase | Current web prototype persistence | Application CRUD | ContactKiller user ownership and provider labels | Current prototype authority; same-provider account boundaries are not represented |
| SurrealDB | No adapter in the sanitized default branch | No | Target provenance contract is documented | Experimental design and external development work |
| ActiveGraph | Domain pack and event runtime | Internal behavior/events | Typed observations, tasks, proposals, and replay | Experimental foundation |
| FalkorDB | No adapter | No | Proposed disposable projection | Community RFC |

## Adapter acceptance checklist

A new source adapter should not move beyond read-only until it proves:

- least-privilege authentication;
- exhaustive pagination and explicit partial-failure semantics;
- exact account and tenant ownership;
- stable provider IDs and idempotent retry behavior;
- source-byte or field-level provenance;
- bounded rate and scope;
- synthetic fixtures for deletion, rename, duplicate, and missing-field cases; and
- credential revocation and cleanup.

A write adapter additionally requires simulation, explicit approval, small batches, restoration, and post-write sentinel monitoring.
