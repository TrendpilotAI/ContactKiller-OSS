# Governance

ContactKiller is an Apache-2.0 open-source project maintained in public once the sanitized release repository is available.

## Roles

### Contributors

Anyone who improves code, tests, documentation, design, research fixtures, or community support through the contribution process.

### Maintainers

Contributors trusted to review changes, triage issues, steward releases, and uphold the project's data-safety boundary. Maintainer status is earned through sustained, high-quality participation and may be granted by the existing maintainers.

### Release maintainers

Maintainers authorized to publish packages, manage deployment credentials, and sign releases. Release access is intentionally narrower than review access.

## Decision making

- Routine changes use lazy consensus through issue and pull-request review.
- Changes to identity rules, provider writes, schemas, persistence authority, licensing, or privacy boundaries require a public design proposal and explicit maintainer approval.
- Maintainers seek consensus. When consensus cannot be reached, the maintainer responsible for the affected subsystem records the decision and dissent in the proposal.
- Security incidents may be handled privately until coordinated disclosure is safe.

## Project records

Architecture decisions, capability status, integration status, and release notes live in the repository. Chat transcripts and private operational data are not governance records.

## Releases

Releases follow semantic versioning once a stable API exists. Until then, `0.x` releases may change rapidly but must still document migrations, safety limitations, and known incompatibilities.

No release may claim production-safe provider mutation without replay, idempotency, tenant-isolation, restoration, bounded-batch, and sentinel-record evidence.

## Conflicts of interest

Reviewers disclose material conflicts and recuse themselves when impartial review is not possible. A contributor should not be the sole approver of a high-risk change they authored.

## Changes to governance

Governance changes require a pull request, a public comment period, and approval from a majority of active maintainers.
