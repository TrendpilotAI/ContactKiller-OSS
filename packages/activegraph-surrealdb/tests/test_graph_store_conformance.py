"""Upstream GraphStoreConformance, unmodified, against each SurrealDB target.

Each case gets a fresh namespace/database and a store that opens its own
connection from the URL, so the owned-connection path is what is tested.
"""

from __future__ import annotations

from typing import Any, Optional

import pytest
from activegraph.store.graph_conformance import GraphStoreConformance

from surreal_support import MEM, SERVER, SURREALKV, Session, Target


class _SurrealGraphStoreConformance(GraphStoreConformance):
    target: Target
    _session: Optional[Session] = None

    def make_store(self) -> Any:
        self._session = self.target.session()
        return self._session.graph_store("conformance", shared=False)

    def cleanup(self) -> None:
        if self._session is not None:
            self._session.close()
            self._session = None


@pytest.mark.skipif(SERVER.skip_reason is not None, reason=SERVER.skip_reason or "")
class TestGraphStoreConformanceServer(_SurrealGraphStoreConformance):
    __test__ = True
    target = SERVER


@pytest.mark.skipif(MEM.skip_reason is not None, reason=MEM.skip_reason or "")
class TestGraphStoreConformanceMem(_SurrealGraphStoreConformance):
    __test__ = True
    target = MEM


@pytest.mark.skipif(SURREALKV.skip_reason is not None, reason=SURREALKV.skip_reason or "")
class TestGraphStoreConformanceSurrealKV(_SurrealGraphStoreConformance):
    __test__ = True
    target = SURREALKV
