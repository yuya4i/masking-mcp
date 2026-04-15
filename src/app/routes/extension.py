"""Browser-extension-facing sanitize endpoint.

This route sits alongside the admin-token-protected ``/sanitize/text``
endpoint but is intentionally *unauthenticated*. The trust model, same
as the rest of the gateway, is loopback-only:

* Docker publishes the port as ``127.0.0.1:8081``.
* The only process that is supposed to call this endpoint is the
  Chrome MV3 extension loaded into the user's own browser.
* Any other localhost process that reaches this endpoint can, at
  worst, submit its own text and receive back the masked version.
  It cannot alter gateway state, leak secrets, or read the audit log.

Decoupling the extension from the admin token lets us ship an install
experience where the user does not have to copy ``data/admin_token``
into their browser. That token is a **write** credential; this route
is strictly **read** (input text → output masked text).
"""
from __future__ import annotations

from fastapi import APIRouter

from app.models.schemas import (
    ExtensionSanitizeRequest,
    ExtensionSanitizeResponse,
    TextSanitizeRequest,
)
from app.services.masking_service import MaskingService
from app.services.repositories import AuditRepository, ConfigRepository

router = APIRouter()

# A single shared ``MaskingService`` instance mirrors the pattern used by
# ``sanitize.py`` / ``proxy.py``. The service itself is stateless except
# for its analyzer cache, so reusing one instance across requests avoids
# re-paying the Sudachi dictionary / Presidio NER load cost every call.
_masking_service = MaskingService(ConfigRepository(), AuditRepository())


@router.post(
    "/sanitize",
    response_model=ExtensionSanitizeResponse,
    summary="Mask PII in a text payload on behalf of a browser extension.",
)
async def extension_sanitize(
    payload: ExtensionSanitizeRequest,
) -> ExtensionSanitizeResponse:
    """Sanitize text coming from a browser extension.

    The handler intentionally does **not** require ``ADMIN_TOKEN``. See
    the module docstring for the trust rationale. Internally it wraps
    the same ``MaskingService.sanitize_text`` used by the legacy
    ``/sanitize/text`` endpoint, so detection coverage is identical:
    Presidio + Sudachi + RegexAnalyzer + preset patterns, subject to
    whatever ``RuntimeConfig`` is in force.

    The audit trail is written with ``request_type="extension"`` so
    operators can filter for extension-originating traffic in
    ``data/audit.jsonl`` via ``jq`` or the admin query endpoint.
    """
    # ``MaskingService`` is the source of truth for masking; everything
    # this route adds is (1) a narrower request schema, (2) an
    # ``extension`` audit tag, and (3) a coarse ``action`` summary.
    result = _masking_service.sanitize_text(
        TextSanitizeRequest(text=payload.text),
        request_type="extension",
        upstream_target=payload.source_url,
    )

    # Coarse action summary. The content script uses this to decide
    # whether to do the text-substitution dance or proceed unchanged.
    # ``filter_enabled == False`` comes back as ``no_change`` because
    # the sanitized text is byte-identical to the input in that path.
    if not result.filter_enabled:
        action = "no_change"
    elif result.sanitized_text != payload.text:
        action = "masked"
    else:
        # Filter ran, but either no detections fired or every
        # detection was allow-listed and left verbatim.
        action = "no_change"

    return ExtensionSanitizeResponse(
        sanitized_text=result.sanitized_text,
        detections=result.detections,
        action=action,
        audit_id=result.audit_id,
    )
