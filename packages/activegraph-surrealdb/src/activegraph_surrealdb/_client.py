"""Connection handling and query execution shared by the stores.

The SurrealDB Python SDK returns one result entry per statement. A store
query here is usually a single ``BEGIN TRANSACTION; ... COMMIT TRANSACTION;``
block, so a failure shows up as several ``ERR`` entries: the statement that
actually failed plus "not executed" / "cancelled" placeholders for the rest.
:func:`run_query` picks out the substantive failure and raises
:class:`SurrealQueryError` with its message and, when the server reports one,
its error kind (``Thrown``, ``TransactionConflict``, ...). The embedded engine
reports messages without kinds, so callers classify on stable message markers
and index names rather than on the kind alone.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional
from urllib.parse import parse_qsl, urlsplit

from activegraph.errors import StorageError

SUPPORTED_SCHEMES = frozenset(
    {"ws", "wss", "http", "https", "mem", "memory", "file", "surrealkv"}
)
EMBEDDED_SCHEMES = frozenset({"mem", "memory", "file", "surrealkv"})
URL_PREFIX = "surrealdb+"

_NAMESPACE_KEYS = ("namespace", "ns")
_DATABASE_KEYS = ("database", "db")

# Placeholder entries SurrealDB attaches to the statements of a failed
# transaction; they are never the root cause. Servers tag them with a detail
# kind; the embedded engine only has the message. A commit that fails on a
# write conflict also starts "Cannot COMMIT:" but is the root cause, so the
# markers below match only the placeholder wording.
_PLACEHOLDER_KINDS = frozenset({"NotExecuted", "Cancelled"})
_PLACEHOLDER_MARKERS = (
    "not executed due to a failed transaction",
    "not executed due to a cancelled transaction",
    "aborted due to a prior error",
)


class SurrealStoreError(StorageError):
    """A SurrealDB request failed in a way the adapter does not map further."""

    _doc_slug = "storage-error"


class SurrealConfigurationError(SurrealStoreError, ValueError):
    """The URL, namespace, database, or credentials are unusable."""


class SurrealQueryError(SurrealStoreError):
    """A SurrealQL statement failed. ``kind`` is set when the server reports it."""

    def __init__(self, message: str, *, kind: Optional[str] = None) -> None:
        super().__init__(
            f"SurrealDB query failed: {message}",
            what_failed=f"SurrealDB rejected a statement: {message}",
            why="The database refused the request, so nothing in it was committed.",
            how_to_fix=(
                "Check that the schema is applied (apply_schema) and that the "
                "configured user may read and write the ActiveGraph tables."
            ),
            context={"message": message, "kind": kind, "driver": "surrealdb"},
        )
        self.message = message
        self.kind = kind


@dataclass(frozen=True)
class SurrealURL:
    """A parsed adapter URL: the SDK URL plus the namespace and database."""

    sdk_url: str
    scheme: str
    namespace: Optional[str]
    database: Optional[str]

    @property
    def embedded(self) -> bool:
        return self.scheme in EMBEDDED_SCHEMES


def parse_surreal_url(url: str) -> SurrealURL:
    """Split ``[surrealdb+]<sdk-url>[?ns=..&db=..]`` into its parts.

    Credentials are never read from the URL: a URL with a ``user:pass@`` part is
    refused so secrets do not end up in logs or run listings.
    """
    if not isinstance(url, str) or not url:
        raise _config_error("the SurrealDB URL is empty", url=None)
    raw = url[len(URL_PREFIX):] if url.lower().startswith(URL_PREFIX) else url
    parts = urlsplit(raw)
    scheme = parts.scheme.lower()
    if scheme not in SUPPORTED_SCHEMES:
        raise _config_error(
            f"unsupported SurrealDB URL scheme {parts.scheme!r}",
            url=url,
            how_to_fix=(
                "Use ws://, wss://, http://, https://, mem://, or "
                "surrealkv://<path> (optionally prefixed with surrealdb+)."
            ),
        )
    if parts.username is not None or parts.password is not None:
        raise _config_error(
            "credentials in the SurrealDB URL are not accepted",
            url=None,
            how_to_fix="Pass username= and password= instead of embedding them in the URL.",
        )
    namespace: Optional[str] = None
    database: Optional[str] = None
    for key, value in parse_qsl(parts.query, keep_blank_values=True):
        if key in _NAMESPACE_KEYS:
            namespace = value
        elif key in _DATABASE_KEYS:
            database = value
        else:
            raise _config_error(
                f"unknown SurrealDB URL parameter {key!r}",
                url=url,
                how_to_fix="Only ns (namespace) and db (database) are accepted.",
            )
    # Strip the query textually: urlunsplit would turn "mem://" into "mem:".
    sdk_url = raw.split("#", 1)[0].split("?", 1)[0]
    return SurrealURL(sdk_url=sdk_url, scheme=scheme, namespace=namespace, database=database)


class Connection:
    """A SurrealDB SDK client, owned (opened from a URL) or borrowed.

    A borrowed client is never closed by the adapter. Pass a borrowed client to
    share one connection between an event store and a graph store; with
    ``mem://`` that is the only way for both to see the same database.
    """

    def __init__(
        self,
        target: Any,
        *,
        namespace: Optional[str] = None,
        database: Optional[str] = None,
        username: Optional[str] = None,
        password: Optional[str] = None,
    ) -> None:
        self.owned = isinstance(target, str)
        self.url: Optional[SurrealURL] = None
        if self.owned:
            self.url = parse_surreal_url(target)
            namespace = namespace or self.url.namespace
            database = database or self.url.database
            self.client = _open_client(self.url)
        else:
            if not callable(getattr(target, "query_raw", None)):
                raise _config_error(
                    f"{type(target).__name__} is not a SurrealDB client",
                    url=None,
                    how_to_fix="Pass a URL string or a connected surrealdb.Surreal client.",
                )
            self.client = target
        self.closed = False
        try:
            if username is not None or password is not None:
                self.client.signin({"username": username, "password": password})
            if namespace is not None or database is not None:
                if not namespace or not database:
                    raise _config_error(
                        "namespace and database must be given together",
                        url=None,
                        how_to_fix="Pass both namespace= and database= (or ns and db URL parameters).",
                    )
                self.client.use(namespace, database)
            elif self.owned:
                raise _config_error(
                    "no namespace or database selected",
                    url=None,
                    how_to_fix="Pass namespace= and database= (or ns and db URL parameters).",
                )
        except BaseException:
            self.close()
            raise
        self.namespace = namespace
        self.database = database

    def query(self, surql: str, variables: Optional[dict[str, Any]] = None) -> list[Any]:
        """Run ``surql`` and return each statement's result, or raise on failure."""
        if self.closed:
            raise SurrealStoreError(
                "the SurrealDB connection is closed",
                what_failed="A store method was called after close().",
                why="Closed handles release their connection and cannot be reused.",
                how_to_fix="Open a new store handle.",
                context={"driver": "surrealdb"},
            )
        response = self.client.query_raw(surql, variables or {})
        return results_or_raise(response)

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        if self.owned:
            try:
                self.client.close()
            except Exception:
                pass


def results_or_raise(response: Any) -> list[Any]:
    """Return per-statement results from a raw SDK response, raising on errors."""
    if not isinstance(response, dict):
        raise SurrealQueryError(f"unexpected response {type(response).__name__}")
    if "error" in response:
        error = response["error"]
        message = error.get("message", error) if isinstance(error, dict) else error
        raise SurrealQueryError(str(message))
    statements = list(response.get("result") or [])
    failures = [s for s in statements if isinstance(s, dict) and s.get("status") == "ERR"]
    if failures:
        real = [s for s in failures if not _is_placeholder(s)]
        failure = (real or failures)[0]
        raise SurrealQueryError(str(failure.get("result")), kind=_error_kind(failure))
    return [s.get("result") if isinstance(s, dict) else s for s in statements]


def tagged_result(results: list[Any], tag: str) -> dict[str, Any]:
    """Find the ``RETURN {tag: true, ...}`` object in a transaction's results.

    Servers echo BEGIN/COMMIT as result entries and the embedded engine does
    not, so the result is located by its tag rather than by position.
    """
    for value in reversed(results):
        if isinstance(value, dict) and value.get(tag) is True:
            return value
    raise SurrealQueryError(f"transaction returned no {tag!r} result")


def _is_placeholder(entry: dict[str, Any]) -> bool:
    if _error_kind(entry) in _PLACEHOLDER_KINDS:
        return True
    message = str(entry.get("result"))
    return any(marker in message for marker in _PLACEHOLDER_MARKERS)


def _error_kind(entry: dict[str, Any]) -> Optional[str]:
    details = entry.get("details")
    if isinstance(details, dict) and isinstance(details.get("kind"), str):
        return details["kind"]
    kind = entry.get("kind")
    return kind if isinstance(kind, str) else None


def _open_client(url: SurrealURL) -> Any:
    from surrealdb import Surreal

    client = Surreal(url.sdk_url)
    if url.embedded:
        client.connect()
    return client


def _config_error(
    summary: str, *, url: Optional[str], how_to_fix: str = "Check the SurrealDB connection settings."
) -> SurrealConfigurationError:
    return SurrealConfigurationError(
        summary,
        what_failed=summary[:1].upper() + summary[1:] + ".",
        why="The adapter refuses to guess a connection target or a database scope.",
        how_to_fix=how_to_fix,
        context={"url": url, "driver": "surrealdb"},
    )
