"""URL parsing and error classification (no database needed)."""

from __future__ import annotations

import pytest

from activegraph_surrealdb import SurrealConfigurationError, SurrealQueryError, parse_surreal_url
from activegraph_surrealdb._client import results_or_raise


@pytest.mark.parametrize(
    ("url", "sdk_url", "namespace", "database"),
    [
        ("ws://127.0.0.1:8000/rpc", "ws://127.0.0.1:8000/rpc", None, None),
        ("surrealdb+wss://db.example.com/rpc?ns=app&db=events", "wss://db.example.com/rpc", "app", "events"),
        ("http://127.0.0.1:8000?namespace=a&database=b", "http://127.0.0.1:8000", "a", "b"),
        ("https://db.example.com", "https://db.example.com", None, None),
        ("mem://?ns=a&db=b", "mem://", "a", "b"),
        ("surrealkv:///var/lib/app/events.skv?ns=a&db=b", "surrealkv:///var/lib/app/events.skv", "a", "b"),
    ],
)
def test_parse_surreal_url(url: str, sdk_url: str, namespace: str | None, database: str | None) -> None:
    parsed = parse_surreal_url(url)
    assert (parsed.sdk_url, parsed.namespace, parsed.database) == (sdk_url, namespace, database)


@pytest.mark.parametrize(
    "url",
    [
        "",
        "/tmp/events.db",
        "sqlite:///events.db",
        "ws://user:secret@127.0.0.1:8000/rpc",
        "ws://127.0.0.1:8000/rpc?ns=a&db=b&token=x",
    ],
)
def test_parse_surreal_url_refuses(url: str) -> None:
    with pytest.raises(SurrealConfigurationError) as caught:
        parse_surreal_url(url)
    assert "secret" not in str(caught.value)


def test_root_cause_is_reported_not_the_placeholders() -> None:
    response = {
        "result": [
            {"status": "ERR", "result": "The query was not executed due to a failed transaction"},
            {"status": "ERR", "result": "An error occurred: boom"},
            {"status": "ERR", "result": "Cannot COMMIT: the transaction was aborted due to a prior error"},
        ]
    }
    with pytest.raises(SurrealQueryError) as caught:
        results_or_raise(response)
    assert caught.value.message == "An error occurred: boom"
    assert caught.value.kind is None


def test_commit_conflict_is_the_root_cause() -> None:
    response = {
        "result": [
            {"status": "ERR", "details": {"kind": "NotExecuted"},
             "result": "The query was not executed due to a failed transaction"},
            {"status": "ERR", "details": {"kind": "TransactionConflict"},
             "result": "Cannot COMMIT: Transaction conflict: Write conflict, retry the transaction."},
        ]
    }
    with pytest.raises(SurrealQueryError) as caught:
        results_or_raise(response)
    assert caught.value.kind == "TransactionConflict"
