"""Upstream EventStoreConformance, unmodified, against each SurrealDB target.

Each case gets a fresh namespace/database and a store that opens its own
connection from the URL, so the owned-connection path is what is tested.
"""

from __future__ import annotations

from typing import Any, Optional

import pytest
from activegraph.store.conformance import EventStoreConformance

from surreal_support import MEM, SERVER, SURREALKV, Session, Target


class _SurrealEventStoreConformance(EventStoreConformance):
    target: Target
    _session: Optional[Session] = None

    def make_store(self, run_id: str) -> Any:
        self._session = self.target.session()
        return self._session.event_store(run_id, shared=False)

    def cleanup(self) -> None:
        if self._session is not None:
            self._session.close()
            self._session = None


@pytest.mark.skipif(SERVER.skip_reason is not None, reason=SERVER.skip_reason or "")
class TestEventStoreConformanceServer(_SurrealEventStoreConformance):
    __test__ = True
    target = SERVER


@pytest.mark.skipif(MEM.skip_reason is not None, reason=MEM.skip_reason or "")
class TestEventStoreConformanceMem(_SurrealEventStoreConformance):
    __test__ = True
    target = MEM


@pytest.mark.skipif(SURREALKV.skip_reason is not None, reason=SURREALKV.skip_reason or "")
class TestEventStoreConformanceSurrealKV(_SurrealEventStoreConformance):
    __test__ = True
    target = SURREALKV
