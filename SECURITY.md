# Security Policy

ContactKiller handles identity and relationship data. Security reports may themselves contain sensitive personal information, so do not file a public issue for a vulnerability.

## Supported versions

ContactKiller has not published a production-ready release. Security fixes currently target the default branch and the latest release candidate only. Experimental branches may change without backward-compatibility guarantees.

## Reporting a vulnerability

Use GitHub's **Report a vulnerability** flow for this repository to open a private security advisory. If that control is unavailable, do not disclose sensitive details in a public issue; wait until private vulnerability reporting is enabled or contact a maintainer through a previously verified private channel.

Please provide:

- the affected commit or release;
- the smallest synthetic reproduction you can create;
- expected and observed behavior;
- likely impact and prerequisites; and
- any temporary mitigation you have tested.

Never send production credentials, real contact exports, raw message history, or third-party personal data. Redact secrets and replace identities with synthetic values.

## High-priority classes

We particularly want private reports about:

- cross-tenant reads or writes;
- OAuth token exposure or confused-deputy flows;
- provider mutations that bypass approval;
- replay or idempotency failures that duplicate or erase records;
- provenance tampering or source-evidence substitution;
- path traversal or permission failures in local snapshot storage; and
- secrets or personal data committed to the repository or build artifacts.

## Disclosure process

Maintainers will acknowledge reports on a best-effort basis, validate them with synthetic data, coordinate remediation and disclosure, and credit reporters who want attribution. Do not publicly disclose an unresolved issue until maintainers have had a reasonable opportunity to prepare a fix and protect affected users.

## Operational warning

This experimental project is not approved for production bulk deletion or autonomous provider writes. A security fix does not convert an unproven provider workflow into a safe one.
