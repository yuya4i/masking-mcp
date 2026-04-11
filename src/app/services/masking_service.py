from __future__ import annotations

import hashlib
import time
import uuid
from collections import Counter
from typing import Iterable

from presidio_analyzer import AnalyzerEngine, RecognizerResult
from presidio_anonymizer import AnonymizerEngine
from presidio_anonymizer.entities import OperatorConfig

from app.models.schemas import AuditRecord, DetectionResult, SanitizeResponse, TextSanitizeRequest
from app.services.repositories import AuditRepository, ConfigRepository


#: Number of characters of surrounding text kept in each DetectionResult's
#: ``context_before`` / ``context_after``. Large enough for a human to see
#: the detection in context, small enough not to bloat the API response.
_CONTEXT_WINDOW_CHARS = 20


class MaskingService:
    def __init__(self, config_repo: ConfigRepository, audit_repo: AuditRepository) -> None:
        self.config_repo = config_repo
        self.audit_repo = audit_repo
        self.analyzer = AnalyzerEngine()
        self.anonymizer = AnonymizerEngine()

    def sanitize_text(self, request: TextSanitizeRequest) -> SanitizeResponse:
        started = time.perf_counter()
        config = self.config_repo.load()
        audit_id = str(uuid.uuid4())

        entity_types = request.entity_types or config.entity_types
        allow_types: set[str] = set(
            request.allow_entity_types
            if request.allow_entity_types is not None
            else config.allow_entity_types
        )
        mask_strategy = request.mask_strategy or config.mask_strategy

        if not config.filter_enabled:
            response = SanitizeResponse(
                audit_id=audit_id,
                filter_enabled=False,
                original_length=len(request.text),
                sanitized_text=request.text,
                detections=[],
                forwarded=False,
            )
            self._write_audit(audit_id, "text", False, [], None, "success", started)
            return response

        # Detect everything the operator asked for. The allow-list filters
        # the masking step only, so allowed entities still show up in the
        # audit trail with ``action="allowed"``.
        recognizer_results = self.analyzer.analyze(
            text=request.text, entities=entity_types, language="en"
        )
        maskable = [r for r in recognizer_results if r.entity_type not in allow_types]

        sanitized_text = self._apply_strategy(request.text, maskable, mask_strategy)
        detections = self._build_detection_results(request.text, recognizer_results, allow_types)

        self._write_audit(audit_id, "text", True, detections, None, "success", started)
        return SanitizeResponse(
            audit_id=audit_id,
            filter_enabled=True,
            original_length=len(request.text),
            sanitized_text=sanitized_text,
            detections=detections,
        )

    def _apply_strategy(
        self,
        text: str,
        detections: list[RecognizerResult],
        mask_strategy: str,
    ) -> str:
        if mask_strategy == "tag":
            operators = {
                item.entity_type: OperatorConfig("replace", {"new_value": f"<{item.entity_type}>"})
                for item in detections
            }
            result = self.anonymizer.anonymize(text=text, analyzer_results=detections, operators=operators)
            return result.text

        if mask_strategy == "partial":
            return self._partial_mask(text, detections)

        if mask_strategy == "hash":
            return self._hash_mask(text, detections)

        return text

    def _partial_mask(self, text: str, detections: list[RecognizerResult]) -> str:
        chars = list(text)
        for item in detections:
            original = text[item.start:item.end]
            if len(original) <= 2:
                masked = "*" * len(original)
            else:
                masked = original[:1] + ("*" * (len(original) - 2)) + original[-1:]
            chars[item.start:item.end] = list(masked)
        return "".join(chars)

    def _hash_mask(self, text: str, detections: list[RecognizerResult]) -> str:
        result = text
        for item in sorted(detections, key=lambda x: x.start, reverse=True):
            original = text[item.start:item.end]
            digest = hashlib.sha256(original.encode("utf-8")).hexdigest()[:10]
            token = f"<{item.entity_type}:{digest}>"
            result = result[:item.start] + token + result[item.end:]
        return result

    def _build_detection_results(
        self,
        text: str,
        detections: Iterable[RecognizerResult],
        allow_types: set[str],
    ) -> list[DetectionResult]:
        results: list[DetectionResult] = []
        for item in detections:
            line, column = _locate_offset(text, item.start)
            before, after = _slice_context(text, item.start, item.end)
            results.append(
                DetectionResult(
                    entity_type=item.entity_type,
                    start=item.start,
                    end=item.end,
                    score=item.score,
                    text=text[item.start:item.end],
                    line=line,
                    column=column,
                    context_before=before,
                    context_after=after,
                    action="allowed" if item.entity_type in allow_types else "masked",
                )
            )
        return results

    def _write_audit(
        self,
        audit_id: str,
        request_type: str,
        filter_enabled: bool,
        detections: list[DetectionResult],
        upstream_target: str | None,
        status: str,
        started: float,
    ) -> None:
        summary = Counter([item.entity_type for item in detections])
        record = AuditRecord(
            audit_id=audit_id,
            request_type=request_type,
            filter_enabled=filter_enabled,
            detected_count=len(detections),
            entity_summary=dict(summary),
            upstream_target=upstream_target,
            status=status,
            elapsed_ms=int((time.perf_counter() - started) * 1000),
            created_at=self.audit_repo.now(),
        )
        self.audit_repo.append(record)


def _locate_offset(text: str, offset: int) -> tuple[int, int]:
    """Return (line, column), both 1-based, for a character offset.

    ``line`` counts ``\\n`` occurrences in ``text[:offset]``; ``column`` is
    the distance from the last preceding newline (or the start of the text).
    Kept deliberately simple — O(offset) per call is fine for PoC payloads.
    Switch to a ``bisect`` over precomputed line starts if you start seeing
    very long inputs with many detections.
    """
    prefix = text[:offset]
    line = prefix.count("\n") + 1
    last_nl = prefix.rfind("\n")
    column = (offset - last_nl) if last_nl >= 0 else (offset + 1)
    return line, column


def _slice_context(
    text: str,
    start: int,
    end: int,
    window: int = _CONTEXT_WINDOW_CHARS,
) -> tuple[str, str]:
    """Return up to ``window`` characters of text on either side of a match.

    The snippets are returned verbatim (newlines preserved). Consumers are
    free to render them however they like — a CLI may replace ``\\n`` with
    a visible marker, a JSON consumer will typically keep them as-is.
    """
    before = text[max(0, start - window):start]
    after = text[end:min(len(text), end + window)]
    return before, after
