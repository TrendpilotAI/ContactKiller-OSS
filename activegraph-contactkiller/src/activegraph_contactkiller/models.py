"""Typed domain objects for ContactKiller's ActiveGraph projection.

The append-only ActiveGraph event log is the system of record. These models
describe the graph projection rebuilt from that log; the projection is never
an independent authority. Integration credentials are references to a secret
manager, never secret values. Raw contact payloads stay outside the event log
and are represented only by a URI plus a SHA-256 digest.
"""

from __future__ import annotations

import hashlib
import re
from datetime import datetime
from typing import Annotated, Literal
from urllib.parse import urlsplit

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)

_SHA256_PATTERN = r"^[0-9a-f]{64}$"
_ISO_8601_PATTERN = (
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}"
    r"(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"
)
_EMAIL_PATTERN = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
_E164_PATTERN = re.compile(r"^\+[1-9]\d{7,14}$")
_PAYLOAD_URI_SCHEMES = frozenset({"file", "s3", "gs", "https", "ipfs"})
_CREDENTIAL_REF_SCHEMES = frozenset({"env", "secret", "vault"})


def _validate_aware_iso8601(value: str) -> str:
    """Validate a real ISO-8601 instant while preserving its string shape."""

    normalized = f"{value[:-1]}+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as error:
        raise ValueError("timestamp must be a real ISO-8601 date and time") from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("timestamp must include a UTC offset or Z suffix")
    return value


AwareISO8601 = Annotated[
    str,
    Field(pattern=_ISO_8601_PATTERN),
    AfterValidator(_validate_aware_iso8601),
]


def sha256_text(value: str) -> str:
    """Return the canonical lowercase SHA-256 hex digest for ``value``."""

    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class DomainModel(BaseModel):
    """Strict base model so unexpected payload or secret fields fail closed."""

    model_config = ConfigDict(extra="forbid")


class Operation(DomainModel):
    operation_key: str = Field(min_length=1)
    kind: Literal["ingest", "reconcile", "project", "mutate", "audit"]
    status: Literal["planned", "running", "succeeded", "failed", "cancelled"]
    requested_by: str = Field(min_length=1)
    idempotency_key: str = Field(min_length=1)
    started_at: AwareISO8601 | None = None
    completed_at: AwareISO8601 | None = None


class Manifest(DomainModel):
    manifest_key: str = Field(min_length=1)
    name: str = Field(min_length=1)
    version: str = Field(min_length=1)
    state: Literal["draft", "active", "superseded", "retired"] = "draft"
    content_uri: str
    content_sha256: str = Field(pattern=_SHA256_PATTERN)
    created_by: str = Field(min_length=1)

    @field_validator("content_uri")
    @classmethod
    def validate_content_uri(cls, value: str) -> str:
        return _validate_external_uri(value, field_name="content_uri")


class Source(DomainModel):
    source_key: str = Field(min_length=1)
    system: Literal[
        "icloud",
        "google_contacts",
        "whatsapp",
        "mesh",
        "hubspot",
        "lightfieldcrm",
        "iphone",
        "other",
    ]
    account_ref: str = Field(min_length=1)
    role: Literal["personal", "business", "crm", "device", "messaging", "unknown"]
    enabled: bool = True


class Integration(DomainModel):
    integration_key: str = Field(min_length=1)
    provider: str = Field(min_length=1)
    status: Literal["configured", "authenticated", "degraded", "disabled"]
    mode: Literal["read", "read_write"] = "read"
    credential_ref: str | None = None

    @field_validator("credential_ref")
    @classmethod
    def validate_credential_reference(cls, value: str | None) -> str | None:
        if value is None:
            return None
        parsed = urlsplit(value)
        if parsed.scheme not in _CREDENTIAL_REF_SCHEMES:
            raise ValueError(
                "credential_ref must be an env://, secret://, or vault:// reference; "
                "secret values must never enter ActiveGraph events"
            )
        if not (parsed.netloc or parsed.path):
            raise ValueError("credential_ref must name a credential")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError(
                "credential_ref must be a stable locator without userinfo, "
                "passwords, query parameters, or fragments"
            )
        return value


class SourceRecord(DomainModel):
    source_record_key: str = Field(min_length=1)
    source_key: str = Field(min_length=1)
    external_id: str = Field(min_length=1)
    payload_uri: str
    payload_sha256: str = Field(pattern=_SHA256_PATTERN)
    schema_version: str = Field(min_length=1)
    observed_at: AwareISO8601

    @field_validator("payload_uri")
    @classmethod
    def validate_payload_uri(cls, value: str) -> str:
        return _validate_external_uri(value, field_name="payload_uri")


class IdentityObservation(DomainModel):
    observation_key: str = Field(min_length=1)
    source_record_key: str = Field(min_length=1)
    person_id: str | None = None
    kind: Literal["email", "e164", "name", "external_id"]
    normalized_value: str = Field(min_length=1)
    value_sha256: str = Field(pattern=_SHA256_PATTERN)
    observed_at: AwareISO8601

    @model_validator(mode="after")
    def validate_canonical_identifier(self) -> IdentityObservation:
        value = self.normalized_value.strip()
        if self.kind == "email":
            value = value.casefold()
            if not _EMAIL_PATTERN.fullmatch(value):
                raise ValueError(
                    "email observations must contain a canonical email address"
                )
        elif self.kind == "e164":
            if not _E164_PATTERN.fullmatch(value):
                raise ValueError("e164 observations must use + followed by 8-15 digits")

        if self.value_sha256 != sha256_text(value):
            raise ValueError("value_sha256 must match the canonical normalized_value")
        self.normalized_value = value
        return self


class Person(DomainModel):
    person_key: str = Field(min_length=1)
    display_name: str = ""
    lifecycle: Literal["active", "archived", "quarantined"] = "active"


class IdentityResolution(DomainModel):
    resolution_key: str = Field(min_length=1)
    candidate_person_ids: tuple[str, str]
    evidence_observation_ids: tuple[str, str]
    match_kind: Literal["email", "e164"]
    match_value_sha256: str = Field(pattern=_SHA256_PATTERN)
    status: Literal["approved", "rejected", "superseded"] = "approved"

    @field_validator("candidate_person_ids", "evidence_observation_ids")
    @classmethod
    def require_two_distinct_ids(cls, value: tuple[str, str]) -> tuple[str, str]:
        if len(value) != 2 or any(not item for item in value) or value[0] == value[1]:
            raise ValueError("resolution pairs require two distinct non-empty ids")
        return value


class ActivityUpdate(DomainModel):
    activity_key: str = Field(min_length=1)
    person_id: str = Field(min_length=1)
    source_record_key: str = Field(min_length=1)
    kind: Literal["email", "meeting", "call", "message", "contact_change", "other"]
    occurred_at: AwareISO8601
    summary: str = ""


class GraphProjection(DomainModel):
    projection_key: str = Field(min_length=1)
    projection_type: Literal["identity", "relationship", "activity", "contact_sync"]
    through_event_id: str = Field(min_length=1)
    state_sha256: str = Field(pattern=_SHA256_PATTERN)
    status: Literal["building", "current", "stale", "failed"]


class Task(DomainModel):
    task_key: str = Field(min_length=1)
    kind: Literal[
        "reconcile_manifest", "review_identity", "apply_mutation", "repair_sync"
    ]
    title: str = Field(min_length=1)
    status: Literal["open", "in_progress", "blocked", "done", "cancelled"] = "open"
    priority: Literal["low", "normal", "high", "critical"] = "normal"
    manifest_id: str | None = None
    operation_id: str | None = None
    requires_approval: bool = False


class ContactMutation(DomainModel):
    """A proposed provider write; gateway enforcement is required.

    ActiveGraph ``PackPolicy`` records approval intent and supports the
    proposal workflow, but it does not intercept arbitrary direct graph
    mutations. Any provider-facing gateway must require an approval event
    before execution and must never infer approval from object existence.
    """

    mutation_key: str = Field(min_length=1)
    person_id: str = Field(min_length=1)
    target_integration_id: str = Field(min_length=1)
    action: Literal["create", "update", "archive", "delete", "merge"]
    field_paths: tuple[str, ...] = ()
    reason: str = Field(min_length=1)
    status: Literal["proposed", "approved", "rejected", "applied", "failed"] = (
        "proposed"
    )


def _validate_external_uri(value: str, *, field_name: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme not in _PAYLOAD_URI_SCHEMES:
        allowed = ", ".join(sorted(_PAYLOAD_URI_SCHEMES))
        raise ValueError(f"{field_name} must use one of these URI schemes: {allowed}")
    if not (parsed.netloc or parsed.path):
        raise ValueError(f"{field_name} must identify an external artifact")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError(
            f"{field_name} must be a stable reference without userinfo, query "
            "parameters, or fragments; signed URLs and embedded credentials must "
            "never enter ActiveGraph events"
        )
    return value


__all__ = [
    "ActivityUpdate",
    "ContactMutation",
    "GraphProjection",
    "IdentityObservation",
    "IdentityResolution",
    "Integration",
    "Manifest",
    "Operation",
    "Person",
    "Source",
    "SourceRecord",
    "Task",
    "sha256_text",
]
