# Third-party notices

ContactKiller source code is licensed under the Apache License, Version 2.0.
Dependencies, optional services, and community projection targets keep their own
licenses. This file calls out the project-level boundaries that are easiest to
misunderstand; package lockfiles remain the authoritative inventory for a build.

## ActiveGraph

The optional `activegraph-contactkiller` package depends on ActiveGraph. ActiveGraph
is licensed under the Apache License, Version 2.0, and its upstream notice states:

> Active Graph<br>
> Copyright 2026 Yohei Nakajima

- License: <https://github.com/yoheinakajima/activegraph/blob/main/LICENSE>
- Notice: <https://github.com/yoheinakajima/activegraph/blob/main/NOTICE>

## SurrealDB

SurrealDB is an optional database target under active development. The SurrealDB
server is not part of ContactKiller and is distributed under the upstream Business
Source License 1.1 terms. Review those terms before offering SurrealDB as a hosted
service or redistributing it.

- License: <https://github.com/surrealdb/surrealdb/blob/main/LICENSE>

## FalkorDB

FalkorDB is discussed only as a possible disposable graph projection. No FalkorDB
adapter or server is bundled. The FalkorDB server repository publishes
source-available terms including the Server Side Public License and Elastic License
2.0; consult upstream to determine which terms apply to your use.

- License: <https://github.com/FalkorDB/FalkorDB/blob/main/LICENSE>

## No relicensing of dependencies

The ContactKiller Apache-2.0 license applies only to original ContactKiller work.
It does not relicense ActiveGraph, SurrealDB, FalkorDB, Supabase, Google APIs, or
any package listed in a dependency manifest.

## Contributor Covenant

`CODE_OF_CONDUCT.md` is adapted from Contributor Covenant, version 2.1. The
ContactKiller copy changes project-specific reporting and enforcement details.
Contributor Covenant is licensed under Creative Commons Attribution 4.0
International (CC BY 4.0).

- Source: <https://www.contributor-covenant.org/version/2/1/code_of_conduct/>
- License: <https://creativecommons.org/licenses/by/4.0/>
