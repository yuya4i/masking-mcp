"""Tests for the Sudachi-based Japanese proper-noun analyzer.

These cover both the standalone ``SudachiProperNounAnalyzer`` and its
integration into ``MaskingService`` behind the opt-in
``RuntimeConfig.morphological_analyzer`` flag. The integration tests
reuse the ``DummyConfigRepository`` / ``DummyAuditRepository`` pattern
from ``test_masking_service.py`` deliberately — keeping the helpers
local makes this PR reviewable in isolation; extracting a conftest is
a follow-up that should ride with a broader test-refactor commit.
"""
from __future__ import annotations

from pathlib import Path

from app.models.schemas import RuntimeConfig, TextSanitizeRequest
from app.services.masking_service import MaskingService
from app.services.repositories import AuditRepository, ConfigRepository
from app.services.analyzers import SudachiProperNounAnalyzer


class DummyConfigRepository(ConfigRepository):
    def __init__(self, config: RuntimeConfig | None = None) -> None:
        self._config = config or RuntimeConfig(filter_enabled=True)
        self.path = Path("/tmp/runtime_config_sudachi_test.json")

    def load(self) -> RuntimeConfig:
        return self._config

    def save(self, config: RuntimeConfig) -> RuntimeConfig:
        self._config = config
        return config


class DummyAuditRepository(AuditRepository):
    def __init__(self) -> None:
        self.records: list = []
        self.path = Path("/tmp/audit_sudachi_test.jsonl")

    def append(self, record) -> None:
        self.records.append(record)


def test_detects_person_and_location() -> None:
    """Well-known proper nouns should round-trip through the analyzer,
    while the verb 住ん(でいる) must not appear in any detection."""
    analyzer = SudachiProperNounAnalyzer()
    detections = analyzer.analyze("田中太郎は東京に住んでいる")

    surfaces = {det.surface for det in detections}
    # Depending on Sudachi's dictionary version the personal name may
    # come through as a single morpheme or split into surname + given
    # name, so we accept either shape. Same for Tokyo.
    assert (
        "田中太郎" in surfaces
        or ("田中" in surfaces and "太郎" in surfaces)
    ), f"expected 田中太郎 in detections, got {surfaces}"
    assert "東京" in surfaces, f"expected 東京 in detections, got {surfaces}"

    # And crucially: no verb stem leaks in.
    assert "住ん" not in surfaces
    assert "住んでいる" not in surfaces

    proper_noun_types = {det.entity_type for det in detections}
    # Every detection must be one of our PROPER_NOUN_* tags.
    assert proper_noun_types <= {
        "PROPER_NOUN",
        "PROPER_NOUN_PERSON",
        "PROPER_NOUN_LOCATION",
        "PROPER_NOUN_ORG",
    }


def test_excludes_common_nouns() -> None:
    """名詞,一般 ('common noun') must never surface as a detection."""
    analyzer = SudachiProperNounAnalyzer()
    detections = analyzer.analyze("これは会社の車です")

    assert detections == [], (
        f"expected zero detections for common-noun-only text, got {detections}"
    )


def test_offsets_are_codepoint_based() -> None:
    """Guard against a regression to byte-based offsets in SudachiPy.

    ``text[detection.start:detection.end]`` must reconstruct the exact
    surface string — if SudachiPy ever flips back to byte offsets for
    multi-byte characters this assertion fails loudly.
    """
    text = "hello 田中 world"
    analyzer = SudachiProperNounAnalyzer()
    detections = analyzer.analyze(text)

    tanaka = next((det for det in detections if det.surface == "田中"), None)
    assert tanaka is not None, f"expected 田中 detection in {text!r}"
    assert text[tanaka.start:tanaka.end] == "田中"


def test_masking_service_integration() -> None:
    """With ``morphological_analyzer="sudachi"`` the service must
    strip Japanese proper nouns from ``sanitized_text`` and report
    them in ``detections``."""
    config = RuntimeConfig(
        filter_enabled=True,
        morphological_analyzer="sudachi",
    )
    service = MaskingService(DummyConfigRepository(config), DummyAuditRepository())
    request = TextSanitizeRequest(text="田中太郎は東京本社にいる")

    result = service.sanitize_text(request)

    assert "田中太郎" not in result.sanitized_text
    assert "東京" not in result.sanitized_text
    assert (
        "<PROPER_NOUN_PERSON>" in result.sanitized_text
        or "<PROPER_NOUN>" in result.sanitized_text
    )

    masked = [d for d in result.detections if d.action == "masked"]
    assert masked, "expected at least one masked Japanese detection"
    assert any(d.entity_type.startswith("PROPER_NOUN") for d in masked)


def test_opt_in_default_off() -> None:
    """With the default config (``morphological_analyzer="none"``) the
    Sudachi analyzer must not run. We assert on the service's internal
    analyzer map rather than Presidio's output — Presidio's English NER
    is free to flag or not flag 東京 on its own, which is out of scope
    for this opt-in guard."""
    config = RuntimeConfig(filter_enabled=True)  # default: "none"
    assert config.morphological_analyzer == "none"

    service = MaskingService(DummyConfigRepository(config), DummyAuditRepository())
    request = TextSanitizeRequest(text="田中太郎は東京にいる")

    service.sanitize_text(request)

    # The lazy Sudachi analyzer must not have been constructed — its
    # presence in the internal analyzer cache would mean the opt-in
    # default leaked.
    assert "sudachi" not in service._analyzers, (
        "Sudachi analyzer was constructed despite morphological_analyzer='none'"
    )
