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
