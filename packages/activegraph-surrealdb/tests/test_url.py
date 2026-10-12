"""URL parsing and error classification (no database needed)."""

from __future__ import annotations

import json

import pytest

from activegraph_surrealdb import (
    SurrealConfigurationError,
    SurrealEventStore,
    SurrealQueryError,
    parse_surreal_url,
)
from activegraph_surrealdb._client import _redact_url, results_or_raise


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


SECRET = "SECRETVALUE"


def _exception_texts(exc: BaseException) -> list[str]:
    texts: list[str] = []
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        texts += [str(current), repr(current), *map(str, current.args)]
        context = getattr(current, "context", None)
        if context is not None:
            texts.append(json.dumps(context, default=str))
        current = current.__cause__ or current.__context__
    return texts


@pytest.mark.parametrize(
    ("url", "redacted"),
    [
        (f"ws://127.0.0.1:8000/rpc?token={SECRET}", "ws://127.0.0.1:8000/rpc?token"),
        (f"ws://127.0.0.1:8000/rpc?ns=a&db=b&password={SECRET}", "ws://127.0.0.1:8000/rpc?ns&db&password"),
        (f"wss://user:{SECRET}@db.example.com/rpc", "wss://db.example.com/rpc"),
        (f"surrealdb+wss://user:{SECRET}@db.example.com:443/rpc?ns=a", "surrealdb+wss://db.example.com:443/rpc?ns"),
        (f"user:{SECRET}@db.example.com", "<redacted SurrealDB URL>"),
        (f"surrealkv:///var/lib/app/events.skv?key={SECRET}", "surrealkv:///var/lib/app/events.skv?key"),
        (f"sqlite:///events.db?key={SECRET}", "sqlite:///events.db?key"),
        (f"ws://127.0.0.1:{SECRET}/rpc", "ws://127.0.0.1/rpc"),
        (f"ws://[::1/rpc?token={SECRET}", "<redacted SurrealDB URL>"),
    ],
)
def test_redact_url(url: str, redacted: str) -> None:
    assert _redact_url(url) == redacted


@pytest.mark.parametrize(
    "url",
    [
        f"ws://127.0.0.1:8000/rpc?token={SECRET}",
        f"ws://127.0.0.1:8000/rpc?ns=a&db=b&password={SECRET}",
        f"ws://user:{SECRET}@127.0.0.1:8000/rpc?ns=a&db=b",
        f"surrealdb+wss://user:{SECRET}@db.example.com/rpc",
        f"user:{SECRET}@db.example.com",
        f"surrealkv:///var/lib/app/events.skv?key={SECRET}",
        f"surrealkv:///var/lib/app/events.skv?ns=a&db=b&key={SECRET}",
        f"sqlite:///events.db?key={SECRET}",
        f"ws://[::1/rpc?token={SECRET}",
    ],
)
@pytest.mark.parametrize("entry", ["parse", "store"])
def test_url_errors_never_echo_secrets(url: str, entry: str) -> None:
    with pytest.raises(SurrealConfigurationError) as caught:
        if entry == "parse":
            parse_surreal_url(url)
        else:
            SurrealEventStore(url, run_id="run_1")
    exc = caught.value
    assert exc.context["url"] is not None
    for text in _exception_texts(exc):
        assert SECRET not in text


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
