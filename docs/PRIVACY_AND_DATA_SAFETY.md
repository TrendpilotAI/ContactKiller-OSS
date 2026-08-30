# Privacy and data safety

ContactKiller exists because contact systems contain intimate, high-impact data. The public project treats privacy as a product boundary, not a deployment toggle.

## Public-repository rule

Only synthetic people and events belong in the public repository. A plausible fixture is not synthetic if it preserves a real person's combination of name, employer, phone, email, location, relationship, or communication history.

Use reserved example domains, clearly fictional organizations, and non-routable or documented example phone ranges. Never derive public fixtures by merely changing one field in a real record.

## Data classes

| Class | Examples | Public repository |
| --- | --- | --- |
| Credentials | OAuth tokens, cookies, API keys, passkeys | Forbidden |
| Direct identifiers | Phone, email, address, provider account ID | Synthetic only |
| Relationship data | Notes, message/calendar history, groups | Synthetic only |
| Source evidence | vCards, API payloads, CRM exports | Synthetic only |
| Derived identity data | Match scores, merge proposals, labels | Synthetic only |
| Aggregate metrics | Counts and overlap statistics | Only from synthetic or explicitly public datasets |

## Local research storage

The Mesh snapshot and DuckDB forensic tools write under `.local/contactkiller/`, which is ignored and should be owner-readable only. Ignoring a path prevents new commits; it does not encrypt data, sanitize backups, or remove previously committed history.

## Development practices

- Use a separate development provider account and tenant.
- Request the narrowest scopes possible.
- Keep read and write credentials separate.
- Do not log raw tokens or contact payloads.
- Set retention limits for snapshots and generated exports.
- Test cleanup and revocation after authentication work.
- Treat screenshots, DOM captures, traces, and build artifacts as possible data exports.

## Release practices

Before any public release:

1. Review the exact Git object history, not only the current working tree.
2. Run secret scanners across all reachable commits.
3. Inspect package and source-archive contents from the release tag.
4. Confirm that example data is independently synthetic.
5. Verify that build logs and preview deployments contain no private environment values.
6. Publish from an allowlisted clean history if the private repository ever contained personal data.

## Real-provider experiments

Real data is outside the open-source contribution workflow. If maintainers perform private acceptance testing, they must use documented authority, preserve backups, start read-only, apply small reversible batches, and keep the evidence outside the public repository.
