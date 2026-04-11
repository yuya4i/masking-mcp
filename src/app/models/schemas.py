from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


ProviderType = Literal["openai", "anthropic", "manus", "generic"]
RouteMode = Literal["native", "openai_compat"]
MaskStrategy = Literal["tag", "partial", "hash"]
#: Per-detection action. ``masked`` entities are replaced in the sanitized
#: text; ``allowed`` entities are detected and reported but left unchanged.
#: Add new values here (e.g. ``"rejected"``) when introducing new policies.
DetectionAction = Literal["masked", "allowed"]


class ProviderConfig(BaseModel):
    provider_id: str
    provider_type: ProviderType
    base_url: str
    enabled: bool = True
    route_mode: RouteMode = "native"
    #: Extra headers the gateway always attaches on behalf of the client
    #: (e.g. a ``User-Agent``). Client-supplied auth headers override these.
    default_headers: dict[str, str] = Field(default_factory=dict)
    model_mapping: dict[str, str] = Field(default_factory=dict)


class RuntimeConfig(BaseModel):
    filter_enabled: bool = True
    fail_closed: bool = True
    #: Entity types Presidio will look for.
    entity_types: list[str] = Field(
        default_factory=lambda: [
            "PERSON",
            "PHONE_NUMBER",
            "EMAIL_ADDRESS",
            "CREDIT_CARD",
            "LOCATION",
        ]
    )
    #: Subset of ``entity_types`` that is *detected but not masked*. Useful
    #: when you want the audit trail to show that a category of PII was
    #: present but intentionally allowed through (e.g. LOCATION in a
    #: geography-aware assistant). Empty list = mask everything detected.
    allow_entity_types: list[str] = Field(default_factory=list)
    mask_strategy: MaskStrategy = "tag"
    #: Opt-in Japanese morphological analyzer. When set to ``"sudachi"``
    #: the masking pipeline runs text through SudachiPy and folds its
    #: proper-noun detections (``PROPER_NOUN_PERSON`` / ``_LOCATION`` /
    #: ``_ORG`` / fallback ``PROPER_NOUN``) into the Presidio result set
    #: before masking. The default ``"none"`` keeps the pre-existing
    #: English-only behaviour untouched, so this field is backward-
    #: compatible with every existing ``runtime_config.json`` on disk.
    morphological_analyzer: Literal["none", "sudachi"] = "none"
    default_provider_id: str = "openai"
    providers: dict[str, ProviderConfig] = Field(default_factory=dict)


class ToggleRequest(BaseModel):
    enabled: bool


class ProviderSelectionRequest(BaseModel):
    provider_id: str


class TextSanitizeRequest(BaseModel):
    text: str
    #: Per-request override of the detector set. Falls back to
    #: ``RuntimeConfig.entity_types`` when omitted.
    entity_types: list[str] | None = None
    #: Per-request override of the pass-through allow-list. Falls back to
    #: ``RuntimeConfig.allow_entity_types`` when omitted. Entries here are
    #: still reported in the ``detections`` list with ``action="allowed"``.
    allow_entity_types: list[str] | None = None
    mask_strategy: MaskStrategy | None = None
    forward_upstream: bool = False
    provider_id: str | None = None
    operation: str | None = None
    upstream_payload: dict[str, Any] | None = None


class DetectionResult(BaseModel):
    entity_type: str
    #: 0-based character offset in the original text.
    start: int
    end: int
    score: float
    #: The matched substring as it appeared in the original text.
    text: str
    #: 1-based line number of ``start`` within the original text.
    line: int
    #: 1-based column of ``start`` on that line.
    column: int
    #: Up to ~20 characters of the original text preceding the match,
    #: suitable for building a human-readable "context" column.
    context_before: str
    #: Up to ~20 characters of the original text following the match.
    context_after: str
    #: What the masking service actually did with this detection.
    action: DetectionAction


class ProviderSelectionResult(BaseModel):
    provider_id: str
    provider_type: ProviderType
    base_url: str
    enabled: bool
    route_mode: RouteMode


class SanitizeResponse(BaseModel):
    audit_id: str
    filter_enabled: bool
    original_length: int
    sanitized_text: str
    detections: list[DetectionResult]
    forwarded: bool = False
    selected_provider: ProviderSelectionResult | None = None
    upstream_response: dict[str, Any] | None = None


class AuditRecord(BaseModel):
    audit_id: str
    request_type: Literal["text", "pdf", "image", "proxy"]
    filter_enabled: bool
    detected_count: int
    entity_summary: dict[str, int]
    upstream_target: str | None = None
    status: Literal["success", "blocked", "error"]
    elapsed_ms: int
    created_at: datetime
