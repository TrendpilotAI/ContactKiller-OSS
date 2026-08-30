# ActiveGraph ContactKiller pack

Experimental ActiveGraph domain pack for provenance-first contact reconciliation.

The pack models source manifests, observations, canonical identities, reconciliation proposals, approvals, tasks, activities, mutation plans, and replayable events. It does not execute provider writes.

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -e '.[test]'
pytest
```

See the repository's [ActiveGraph guide](https://github.com/TrendpilotAI/ContactKiller-OSS/blob/main/docs/ACTIVEGRAPH.md), [architecture](https://github.com/TrendpilotAI/ContactKiller-OSS/blob/main/docs/ARCHITECTURE.md), and [privacy policy](https://github.com/TrendpilotAI/ContactKiller-OSS/blob/main/docs/PRIVACY_AND_DATA_SAFETY.md).

Licensed under Apache License 2.0.
