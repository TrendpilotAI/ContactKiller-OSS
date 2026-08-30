## What changed

<!-- Describe the smallest complete behavior change. -->

## Why

<!-- Link the issue or design proposal and name the user/contributor outcome. -->

## Verification

<!-- List exact commands and results. Do not write “CI passed” without naming scope. -->

- [ ] Focused tests
- [ ] Lint/type check
- [ ] Build
- [ ] Documentation/status matrix updated

## Data-integrity review

- [ ] Source observations remain attributable and immutable.
- [ ] Ingestion is account-scoped, paginated, and idempotent.
- [ ] Partial sync cannot erase omitted fields.
- [ ] Names alone do not create automatic identity links.
- [ ] External writes remain approval-gated and bounded.
- [ ] Replay, tenant-isolation, and rollback impact is covered where relevant.

## Privacy review

- [ ] Every committed identity and event is synthetic.
- [ ] No tokens, cookies, API keys, account IDs, contact exports, messages, screenshots, or private logs are included.
- [ ] Generated artifacts and local databases are excluded.

## Screenshots

<!-- UI changes: attach synthetic desktop/mobile evidence. Otherwise write “Not applicable.” -->
