from __future__ import annotations

import hashlib
import time
import uuid
from collections import Counter
from typing import Iterable

from presidio_analyzer import RecognizerResult
from presidio_anonymizer import AnonymizerEngine
from presidio_anonymizer.entities import OperatorConfig

from app.models.schemas import (
    AuditRecord,
    DetectionResult,
    RuntimeConfig,
    SanitizeResponse,
    TextSanitizeRequest,
)
from app.services.analyzers import (
    Analyzer,
    AnalyzerRequest,
    PresidioAnalyzer,
    RegexAnalyzer,
    SudachiProperNounAnalyzer,
)
from app.services.language_detection import detect_language
from app.services.repositories import AuditRepository, ConfigRepository


#: Number of characters of surrounding text kept in each DetectionResult's
#: ``context_before`` / ``context_after``. Large enough for a human to see
#: the detection in context, small enough not to bloat the API response.
_CONTEXT_WINDOW_CHARS = 20


class MaskingService:
    def __init__(self, config_repo: ConfigRepository, audit_repo: AuditRepository) -> None:
        self.config_repo = config_repo
        self.audit_repo = audit_repo
        self.anonymizer = AnonymizerEngine()
        #: Lazily populated map of active analyzers keyed by ``Analyzer.name``.
        #: A dict (rather than a list) because a future ``allow_entity_types``
        #: extension may want to disable a specific analyzer by string, which
        #: is an O(1) lookup here and avoids a linear scan over instances.
        #: Analyzers are added on first use so operators who never opt in to
        #: ``morphological_analyzer="sudachi"`` never pay the Sudachi dict
        #: load cost at service boot.
        self._analyzers: dict[str, Analyzer] = {}
        #: Construction fingerprint per analyzer so the service can rebuild
        #: a cached instance when its ``RuntimeConfig`` inputs change between
        #: requests. Keyed by analyzer name, value is an opaque hashable that
        #: the matching branch of ``_get_analyzer`` knows how to compare
        #: against the current config (``None`` for analyzers that take no
        #: config at all, e.g. :class:`PresidioAnalyzer`).
        self._analyzer_fingerprints: dict[str, object] = {}

    def _get_analyzer(self, name: str, config: RuntimeConfig | None = None) -> Analyzer:
        """Return the cached analyzer for ``name``, constructing it on demand.

        The constructor map is intentionally kept inline — adding a new
        analyzer means adding one elif branch here plus a new module in
        ``app.services.analyzers``. When the list grows beyond three or
        four backends, consider promoting this to a registry decorator.

        For analyzers whose construction depends on ``RuntimeConfig``
        (currently only Sudachi), the service records a *fingerprint* of
        the kwargs it built the instance with and, if the current config
        disagrees, transparently rebuilds the analyzer. This keeps the
        dict keyed by the short ``name`` string (so callers can still
        write ``"sudachi" in self._analyzers`` the way the existing tests
        do) while still honouring live-config edits between requests.
        """
        fingerprint: object | None = None

        if name == "sudachi":
            # Sudachi's constructor kwargs are exposed in RuntimeConfig,
            # so the fingerprint needs to round-trip through a hashable
            # tuple for the equality check below. Nested lists become
            # tuples of tuples — cheap, deterministic.
            if config is None:
                raise ValueError(
                    "MaskingService._get_analyzer('sudachi') requires a RuntimeConfig"
                )
            # Backward-compatible fingerprint shape: when the new
            # ``prefer_surname_for_ambiguous`` flag is False (the
            # default), we emit the legacy two-tuple that the
            # existing ``test_masking_service_honors_sudachi_config``
            # assertion locks in. When the flag is True we append
            # a third element so a live flip between False/True
            # still rebuilds the cached analyzer — the tuple
            # mismatch drives the rebuild path a few lines below.
            base_fingerprint = (
                config.sudachi_split_mode,
                tuple(tuple(p) for p in config.proper_noun_pos_patterns),
            )
            if config.prefer_surname_for_ambiguous:
                fingerprint = (*base_fingerprint, True)
            else:
                fingerprint = base_fingerprint
        elif name == "regex":
            # Regex patterns are fully described by the (entity_type,
            # pattern) pairs in RuntimeConfig. Round-trip through a
            # tuple so the equality check below can detect a live-edit
            # to ``regex_patterns`` and rebuild the compiled analyzer.
            if config is None:
                raise ValueError(
                    "MaskingService._get_analyzer('regex') requires a RuntimeConfig"
                )
            fingerprint = tuple(tuple(p) for p in config.regex_patterns)

        cached = self._analyzers.get(name)
        if cached is not None and self._analyzer_fingerprints.get(name) == fingerprint:
            return cached

        if name == "presidio":
            analyzer: Analyzer = PresidioAnalyzer()
        elif name == "sudachi":
            assert config is not None  # guarded above; helps the type checker
            analyzer = SudachiProperNounAnalyzer(
                split_mode=config.sudachi_split_mode,
                pos_patterns=[list(p) for p in config.proper_noun_pos_patterns],
                prefer_surname_for_ambiguous=config.prefer_surname_for_ambiguous,
            )
        elif name == "regex":
            assert config is not None  # guarded above; helps the type checker
            # Coerce each inner list to a 2-tuple for RegexAnalyzer's
            # signature. Patterns shorter than 2 elements are ignored
            # defensively — an operator who hand-edits runtime_config.json
            # should get a cleaner fall-through than a RegexAnalyzer
            # TypeError at construction time.
            compiled: list[tuple[str, str]] = [
                (entry[0], entry[1]) for entry in config.regex_patterns if len(entry) >= 2
            ]
            analyzer = RegexAnalyzer(compiled)
        else:
            raise ValueError(f"unknown analyzer: {name!r}")

        self._analyzers[name] = analyzer
        self._analyzer_fingerprints[name] = fingerprint
        return analyzer

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

        # Presidio always runs (pre-refactor default). Sudachi is the
        # opt-in secondary pass that was previously hard-wired behind an
        # ``if config.morphological_analyzer == "sudachi"`` branch. We
        # keep the primary / secondary split explicit so the behaviour
        # is byte-for-byte identical to the pre-refactor code: the
        # overlap resolver is only invoked when Sudachi actually
        # contributed at least one span, preserving Presidio's native
        # ordering in the common English-only case.
        analyzer_request = AnalyzerRequest(
            text=request.text,
            entity_types=list(entity_types),
            language="en",
        )

        # Two dispatch modes, chosen by whether the operator opted in to
        # per-language routing via ``config.analyzers_by_language``:
        #
        # - legacy (``analyzers_by_language is None``): Presidio always,
        #   Sudachi conditionally. Byte-for-byte identical to every
        #   release before this commit.
        # - language-aware: run the CJK-ratio detector on the request
        #   text, look up the analyzer chain for the detected language
        #   (falling back through ``mixed`` → ``en`` so an operator only
        #   has to configure the two or three chains they actually need),
        #   and run exactly that subset of analyzers.
        #
        # Result merging / overlap resolution / allow filter / masking
        # strategy is shared between the two modes — only the analyzer
        # selection differs.
        if config.analyzers_by_language is None:
            recognizer_results: list[RecognizerResult] = self._get_analyzer(
                "presidio"
            ).analyze(analyzer_request)

            if config.morphological_analyzer == "sudachi":
                sudachi_results = self._get_analyzer("sudachi", config).analyze(
                    analyzer_request
                )
                if sudachi_results:
                    recognizer_results = _resolve_overlaps(
                        list(recognizer_results) + list(sudachi_results)
                    )
        else:
            recognizer_results = self._run_language_aware_chain(
                analyzer_request, config
            )

        # Drop low-confidence detections before anything else touches the
        # merged list. Applied exactly once, on the already-merged result
        # set, so the filter sees the final union of every analyzer that
        # ran — no individual analyzer has to know about ``min_score``
        # itself. ``min_score == 0.0`` (the default) is a no-op and
        # preserves the pre-threshold behaviour byte-for-byte.
        if config.min_score > 0.0:
            recognizer_results = [
                r for r in recognizer_results if r.score >= config.min_score
            ]

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

    def _run_language_aware_chain(
        self,
        analyzer_request: AnalyzerRequest,
        config: RuntimeConfig,
    ) -> list[RecognizerResult]:
        """Run the analyzer chain selected by the detected language.

        Called only when ``config.analyzers_by_language is not None``.
        Everything about result merging, overlap resolution, the
        allow-list filter, and the masking strategy is identical to
        the legacy path — the only thing that differs here is
        *which* analyzers run. That keeps the dispatcher trivially
        reviewable and means adding a new analyzer to the chain is a
        one-line config change rather than a code change.

        Fallback ladder: the detector returns ``"ja"`` / ``"en"`` /
        ``"mixed"``. If the operator did not provide an explicit chain
        for the detected label, we fall back to ``"mixed"`` (the most
        permissive) and then ``"en"`` (the pre-language-aware default
        chain). An empty chain after the fallback means "no analyzer
        runs", which is a legitimate pass-through mode — we honour it
        rather than silently re-enabling Presidio.
        """
        # Presidio expects ``language="en"`` today; teach analyzers that
        # actually care about locale about the detected label while
        # keeping the existing contract for the English-only backend.
        detected = detect_language(
            analyzer_request.text,
            ja_threshold=config.language_detection_ja_threshold,
        )
        chain_map = config.analyzers_by_language
        # ``chain_map`` can be ``None`` only in the legacy path, which
        # is branched above; the assert documents the invariant for
        # any future refactor that might call this helper directly.
        assert chain_map is not None
        if detected in chain_map:
            chain = chain_map[detected]
        else:
            chain = chain_map.get("mixed", chain_map.get("en", []))

        recognizer_results: list[RecognizerResult] = []
        contributed_names: set[str] = set()
        for analyzer_name in chain:
            # ``regex`` is the one analyzer whose chain membership is
            # conditional on the config actually containing any
            # patterns — an empty ``regex_patterns`` list with ``regex``
            # listed in the chain is treated as a no-op, not an error,
            # so operators can leave the chain config stable while they
            # enable / disable the pattern set independently.
            if analyzer_name == "regex" and not config.regex_patterns:
                continue
            analyzer = self._get_analyzer(analyzer_name, config)
            results = analyzer.analyze(analyzer_request)
            if results:
                recognizer_results.extend(results)
                contributed_names.add(analyzer_name)

        # Only run the overlap resolver when at least two analyzers
        # contributed — a single analyzer cannot overlap with itself
        # in a way the resolver cares about, and skipping it preserves
        # result order for the common "just Presidio" or "just Sudachi"
        # case.
        if len(contributed_names) > 1:
            recognizer_results = _resolve_overlaps(recognizer_results)
        return recognizer_results

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


def _resolve_overlaps(results: list[RecognizerResult]) -> list[RecognizerResult]:
    """Drop detections fully contained within a higher-scoring neighbour.

    Presidio + Sudachi can sometimes flag the same Japanese span twice —
    e.g. a ``LOCATION`` from Presidio's English NER and a
    ``PROPER_NOUN_LOCATION`` from Sudachi on the same character range.
    Keeping both would produce duplicate entries in ``detections`` and,
    worse, the ``partial`` and ``hash`` masking strategies would mutate
    the same offsets twice. This resolver keeps partial overlaps intact
    (they may legitimately describe different pieces of information) but
    discards any entry that is a strict subset of another with a higher
    score. Ties stay deterministic: the first entry wins.

    The implementation is a single linear sweep-line over results
    sorted by ``(start ascending, end descending)``. That sort order
    guarantees every candidate's potential dominator appears strictly
    before it in the walk:

    * If ``prior.start < candidate.start``, then length is strict by
      construction whenever ``prior.end >= candidate.end``.
    * If ``prior.start == candidate.start``, the ``-end`` secondary
      key puts the longer span first, so again any prior with
      ``prior.end > candidate.end`` has strictly greater length; a
      tied ``(start, end)`` pair is *not* considered dominance.

    The sweep maintains a single running "envelope" — the strongest
    dominator seen so far, identified by ``(end, score)``. Each
    candidate is checked against the envelope in O(1); if it survives,
    it optionally replaces the envelope when it extends further or
    matches the end with a strictly higher score. The final complexity
    is ``O(n log n)`` dominated by the sort plus an ``O(n)`` sweep —
    a clean improvement over the previous ``O(n²)`` nested scan on
    payloads with hundreds of detections.
    """
    if len(results) < 2:
        return list(results)

    # Sort once. ``(start, -end)`` = (start ASC, end DESC) because the
    # tuple comparison treats the second element as a number. That
    # order is what lets the sweep treat "processed earlier" as
    # "potentially dominates the current candidate".
    ordered = sorted(results, key=lambda r: (r.start, -r.end))

    keepers: list[RecognizerResult] = []
    # Envelope = the strongest dominator candidate walked so far. The
    # sentinel values here (``-1`` / ``-1.0``) are unreachable from a
    # real ``RecognizerResult`` — offsets are non-negative and scores
    # live in ``[0.0, 1.0]`` — so the first iteration always installs
    # a real envelope without a special-case branch.
    envelope_start = -1
    envelope_end = -1
    envelope_score = -1.0

    for candidate in ordered:
        # By the sort contract, ``envelope_start <= candidate.start``
        # holds whenever the envelope is set. Length-strict dominance
        # therefore reduces to "envelope started earlier OR ended
        # later" — exactly the ``(start, end) != candidate's span``
        # escape hatch that stops identical spans from eliminating
        # each other.
        if (
            envelope_end >= candidate.end
            and envelope_score >= candidate.score
            and (envelope_start < candidate.start or envelope_end > candidate.end)
        ):
            continue

        keepers.append(candidate)

        # Promote the envelope to the strictly-stronger of the two:
        # longer span wins, and on an end-tie the higher score wins.
        # That keeps the envelope maximally useful for subsequent
        # smaller candidates without ever demoting to a weaker one.
        if candidate.end > envelope_end or (
            candidate.end == envelope_end and candidate.score > envelope_score
        ):
            envelope_start = candidate.start
            envelope_end = candidate.end
            envelope_score = candidate.score

    return keepers


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
