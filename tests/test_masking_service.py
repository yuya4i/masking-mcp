from pathlib import Path

from app.models.schemas import RuntimeConfig, TextSanitizeRequest
from app.services.masking_service import MaskingService
from app.services.repositories import AuditRepository, ConfigRepository


class DummyConfigRepository(ConfigRepository):
    def __init__(self) -> None:
        self._config = RuntimeConfig(filter_enabled=True)
        self.path = Path("/tmp/runtime_config_test.json")

    def load(self) -> RuntimeConfig:
        return self._config

    def save(self, config: RuntimeConfig) -> RuntimeConfig:
        self._config = config
        return config


class DummyAuditRepository(AuditRepository):
    def __init__(self) -> None:
        self.records = []
        self.path = Path("/tmp/audit_test.jsonl")

    def append(self, record) -> None:
        self.records.append(record)


def test_sanitize_text_masks_email_and_phone() -> None:
    service = MaskingService(DummyConfigRepository(), DummyAuditRepository())
    request = TextSanitizeRequest(text="contact me at user@example.com or 09012345678")

    result = service.sanitize_text(request)

    assert result.filter_enabled is True
    assert result.original_length > 0
    assert isinstance(result.sanitized_text, str)


def test_filter_off_passthrough() -> None:
    config_repo = DummyConfigRepository()
    config = config_repo.load()
    config.filter_enabled = False
    config_repo.save(config)

    service = MaskingService(config_repo, DummyAuditRepository())
    request = TextSanitizeRequest(text="plain text")
    result = service.sanitize_text(request)

    assert result.filter_enabled is False
    assert result.sanitized_text == "plain text"


def test_detection_results_include_location_and_context() -> None:
    """Each detection should carry enough info to render a readable table."""
    service = MaskingService(DummyConfigRepository(), DummyAuditRepository())
    request = TextSanitizeRequest(
        text="header line\ncontact: user@example.com here",
    )

    result = service.sanitize_text(request)

    email = next(
        (d for d in result.detections if d.entity_type == "EMAIL_ADDRESS"),
        None,
    )
    assert email is not None, "expected EMAIL_ADDRESS detection"
    assert email.text == "user@example.com"
    assert email.line == 2  # second line, after the header newline
    assert email.column >= 1
    assert "contact" in email.context_before
    assert "here" in email.context_after
    assert email.action == "masked"


def test_allow_entity_types_are_detected_but_not_masked() -> None:
    """Allow-listed types should survive into sanitized_text verbatim."""
    service = MaskingService(DummyConfigRepository(), DummyAuditRepository())
    request = TextSanitizeRequest(
        text="my email is user@example.com",
        allow_entity_types=["EMAIL_ADDRESS"],
    )

    result = service.sanitize_text(request)

    # Not masked
    assert "user@example.com" in result.sanitized_text
    # But still reported as an "allowed" detection
    email = next(
        (d for d in result.detections if d.entity_type == "EMAIL_ADDRESS"),
        None,
    )
    assert email is not None, "allowed types must still appear in detections"
    assert email.action == "allowed"


def test_analyzers_by_language_dispatch_en() -> None:
    """With ``analyzers_by_language`` set, an English payload must run
    only the ``en`` chain — here, Presidio only. Sudachi must not
    contribute any PROPER_NOUN_* detections because it never ran.

    We deliberately include Sudachi in the ``ja`` chain so the test
    also pins the other half of the dispatcher contract: wiring
    Sudachi into some chain must not cause it to fire on English
    text when the detector picked ``en``.
    """
    config = RuntimeConfig(
        filter_enabled=True,
        analyzers_by_language={
            "en": ["presidio"],
            "ja": ["sudachi"],
        },
    )
    service = MaskingService(DummyConfigRepository(config), DummyAuditRepository())
    request = TextSanitizeRequest(text="Contact user@example.com right now")

    result = service.sanitize_text(request)

    # Presidio picks up the email address — that is enough evidence
    # that the ``en`` chain ran.
    assert any(d.entity_type == "EMAIL_ADDRESS" for d in result.detections)
    # And no PROPER_NOUN_* — Sudachi is configured for ``ja`` only, so
    # on a pure-English payload it must not have been invoked.
    assert not any(
        d.entity_type.startswith("PROPER_NOUN") for d in result.detections
    ), f"Sudachi leaked on English input: {result.detections}"
    # As a belt-and-braces check, the Sudachi analyzer must not have
    # been cached by the service — the lazy construction is our
    # tripwire for "was it called at all?".
    assert "sudachi" not in service._analyzers, (
        "Sudachi analyzer was constructed on an English payload despite "
        "analyzers_by_language routing it to the ``ja`` chain only"
    )


def test_analyzers_by_language_dispatch_ja() -> None:
    """With the same config, a Japanese payload must route through
    Sudachi and surface at least one PROPER_NOUN_* detection."""
    config = RuntimeConfig(
        filter_enabled=True,
        analyzers_by_language={
            "en": ["presidio"],
            "ja": ["sudachi"],
        },
    )
    service = MaskingService(DummyConfigRepository(config), DummyAuditRepository())
    request = TextSanitizeRequest(text="田中太郎は東京本社にいる")

    result = service.sanitize_text(request)

    masked = [d for d in result.detections if d.action == "masked"]
    assert masked, "expected at least one Sudachi detection on Japanese text"
    assert any(d.entity_type.startswith("PROPER_NOUN") for d in masked), (
        f"expected PROPER_NOUN_* detections from Sudachi, got "
        f"{[d.entity_type for d in masked]}"
    )


def test_regex_recognizer_flags_pattern() -> None:
    """A configured regex pattern must fire on matching text and
    surface as a maskable detection under its configured entity type."""
    config = RuntimeConfig(
        filter_enabled=True,
        analyzers_by_language={"en": ["presidio", "regex"]},
        regex_patterns=[["EMPLOYEE_ID", r"EMP-\d{5}"]],
    )
    service = MaskingService(DummyConfigRepository(config), DummyAuditRepository())
    request = TextSanitizeRequest(text="employee EMP-12345 logged in")

    result = service.sanitize_text(request)

    # The regex hit must appear in detections with the configured tag.
    employee = next(
        (d for d in result.detections if d.entity_type == "EMPLOYEE_ID"),
        None,
    )
    assert employee is not None, (
        f"expected EMPLOYEE_ID detection, got {[d.entity_type for d in result.detections]}"
    )
    assert employee.text == "EMP-12345"
    assert employee.action == "masked"
    # And the masked text must carry the entity-type tag rather than
    # the raw identifier, matching the ``tag`` mask strategy contract.
    assert "EMP-12345" not in result.sanitized_text
    assert "<EMPLOYEE_ID>" in result.sanitized_text
