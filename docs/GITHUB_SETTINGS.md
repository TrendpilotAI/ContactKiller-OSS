# Recommended GitHub settings

The current private `TrendpilotAI/ContactKiller` repository is an internal archive.
Do not change its visibility: historical refs contain private operational evidence
and old credential-like values.

Publish the allow-listed release snapshot as a new repository:

- **Name:** `ContactKiller-OSS`
- **Description:** Experimental open-source contact reconciliation with provenance, replayable models, and human-gated cleanup plans.
- **Website:** `https://website-alpha-rose-81.vercel.app`
- **License:** Apache-2.0
- **Topics:** `contacts`, `identity-resolution`, `data-provenance`, `activegraph`, `surrealdb`, `falkordb`, `nextjs`, `open-source`

## Protection baseline

Before accepting contributions:

1. Require the `Public release`, `Source tools`, `Web prototype`, `Launch site`, and `ActiveGraph pack` checks on `main`.
2. Require pull requests and at least one approving review.
3. Require conversation resolution and block force pushes and branch deletion.
4. Enable Dependabot, secret scanning, push protection, and private vulnerability reporting.
5. Keep Actions permissions read-only except where a workflow explicitly needs more.
6. Do not import private pull-request refs or branches from the internal archive.

## Initial publication sequence

1. Run `bun scripts/check-public-release.ts` from the clean snapshot.
2. Run the full local verification matrix in [Testing](TESTING.md).
3. Create a new empty repository without importing history.
4. Commit only the allow-listed snapshot as the new root commit.
5. Push `main`, apply the settings above, and confirm every check from GitHub.
6. Verify the public tree and release archives contain no excluded paths.
