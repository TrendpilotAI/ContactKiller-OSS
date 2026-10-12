from __future__ import annotations

from collections.abc import Iterator

import pytest

from surreal_support import PRIMARY, Session


@pytest.fixture
def session() -> Iterator[Session]:
    """A fresh database on the server (when configured) or embedded mem://."""
    if PRIMARY.skip_reason:
        pytest.skip(PRIMARY.skip_reason)
    current = PRIMARY.session()
    try:
        yield current
    finally:
        current.close()
