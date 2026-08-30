# Open-source release checklist

This file is the public-release gate and evidence ledger. A checked documentation box does not authorize changing the private archive's visibility. History checks below apply to the new public root, not to the deliberately excluded internal history.

## Documentation and licensing

- [x] Apache License 2.0
- [x] NOTICE
- [x] Public README with experimental status
- [x] Contribution guide and code of conduct
- [x] Security policy
- [x] Governance and roadmap
- [x] Capability and integration truth tables
- [x] Privacy and synthetic-data policy

## Repository hygiene

- [x] Private audit site removed from the release snapshot
- [x] Competitor-research bundle removed from the release snapshot
- [x] Personal product requirements replaced with public product truth
- [x] Internal history is documented as unsafe for publication and excluded from the release
- [x] New public root full-history secret scan passes
- [x] New public root full-history personal-data review passes
- [x] Sanitized working-tree secret scan passes
- [x] Generated artifacts and local databases are absent from the release tree
- [x] Public package contents are reviewed with an exact allowlist and reviewed-binary digests
- [x] Every public fixture is synthetic

## Local engineering gates

- [x] Web prototype builds without production credentials
- [x] ActiveGraph pack tests pass from a clean environment
- [x] Source-tool tests pass
- [x] Public website passes desktop, mobile, accessibility, and deployment checks

## Hosted post-publication gates

These checks require the sanitized root to exist on the new remote. They do not block creating the empty public repository or making the first root push.

- [ ] Default branch CI passes from a clean checkout
- [ ] Dependency review and secret scanning are enabled
- [ ] Branch protection requires review and CI

## Publication gate

The private repository's current history contains personal operational material. Deleting it in a later commit does not remove it from Git history. The chosen release strategy is a new repository seeded from the sanitized snapshot as a new root commit. Never change the private archive's visibility or import any of its refs.

- [x] Choose a new root-history repository (`TrendpilotAI/ContactKiller-OSS`)
- [x] Review the exact public tree and object list
- [x] Create and scan the sanitized local root commit
- [ ] Create the empty public repository after the local root-history gates pass
- [ ] Push only the sanitized root history and verify the public object graph
- [ ] Verify hosted CI and repository protections

A signed version tag and GitHub release may be created after the public object graph, hosted CI, and repository protections are verified. They are release evidence, not a prerequisite for creating the empty remote.
