# ActiveGraph ContactKiller pack

Experimental ActiveGraph domain pack for provenance-first contact reconciliation.

The pack models source manifests, observations, canonical identities, reconciliation proposals, approvals, tasks, activities, mutation plans, and replayable events. It does not execute provider writes.

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -e '.[test]'
pytest
```

The replay tests run against SQLite by default. To run the same tests against a
local PostgreSQL server, install the `postgres` extra and point
`CONTACTKILLER_TEST_POSTGRES_URL` at a role that may create databases; each test
creates and drops its own database:

```bash
python -m pip install -e '.[test,postgres]'
CONTACTKILLER_TEST_POSTGRES_URL='postgresql://postgres:<password>@localhost:5432/postgres' pytest
```

See the repository's [ActiveGraph guide](https://github.com/TrendpilotAI/ContactKiller-OSS/blob/main/docs/ACTIVEGRAPH.md), [architecture](https://github.com/TrendpilotAI/ContactKiller-OSS/blob/main/docs/ARCHITECTURE.md), and [privacy policy](https://github.com/TrendpilotAI/ContactKiller-OSS/blob/main/docs/PRIVACY_AND_DATA_SAFETY.md).

Licensed under Apache License 2.0.
