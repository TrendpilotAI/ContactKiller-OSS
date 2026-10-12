"""SurrealDB backend for ActiveGraph: an EventStore and a GraphStore.

``SurrealEventStore`` implements the ActiveGraph 1.12 ``EventStore`` protocol
(plus the run-metadata, snapshot and fork helpers the reference stores
expose); ``SurrealGraphStore`` implements the ``GraphStore`` ABC. Both pass
the upstream conformance suites.
"""

from ._client import (
    SurrealConfigurationError,
    SurrealQueryError,
    SurrealStoreError,
    SurrealURL,
    parse_surreal_url,
)
from .event_store import SurrealEventStore, open_surreal_store
from .graph_store import SurrealGraphStore
from .schema import SCHEMA_VERSION, apply_schema, schema_text

__version__ = "0.1.0"

__all__ = [
    "SCHEMA_VERSION",
    "SurrealConfigurationError",
    "SurrealEventStore",
    "SurrealGraphStore",
    "SurrealQueryError",
    "SurrealStoreError",
    "SurrealURL",
    "__version__",
    "apply_schema",
    "open_surreal_store",
    "parse_surreal_url",
    "schema_text",
]
