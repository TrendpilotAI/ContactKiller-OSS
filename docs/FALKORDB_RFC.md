# RFC: disposable FalkorDB projection

**Status:** community exploration; not implemented or supported.

## Question

Can a FalkorDB projection improve interactive relationship and provenance queries while remaining fully disposable and reproducible from ContactKiller's canonical history?

## Non-goals

- FalkorDB must not become a second source of truth.
- The projection must not store the only copy of provider evidence, approvals, or mutation results.
- This RFC does not authorize provider writes or personal-data exports.

## Proposed boundary

```text
canonical events + observations
              │
              ▼
      deterministic projector
              │
              ▼
     FalkorDB disposable graph
              │
              ├── provenance traversal
              ├── duplicate-candidate exploration
              └── relationship visualization
```

The projector should support a full rebuild and an incremental checkpoint. Every node and edge should retain the canonical event or observation ID that produced it.

## Evaluation questions

- Can a clean rebuild produce an equivalent graph digest?
- Which provenance and neighborhood queries become materially simpler or faster?
- How are deletions, superseded proposals, and rejected matches represented?
- Can tenant boundaries be guaranteed during projection and query?
- What operational cost does an additional projection create?
- Does the adapter fit ActiveGraph's graph-store seam without coupling domain behavior to FalkorDB?

## Contribution packet

A prototype pull request should include:

- a synthetic dataset;
- projector interface and implementation;
- full-rebuild and incremental tests;
- equivalence and tenant-isolation checks;
- benchmark methodology and raw synthetic results; and
- documentation that states the projection is disposable.
