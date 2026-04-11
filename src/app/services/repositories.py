from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from app.config import get_settings
from app.models.schemas import AuditRecord, ProviderConfig, RuntimeConfig


class ConfigRepository:
    def __init__(self) -> None:
        self.settings = get_settings()
        self.path: Path = self.settings.runtime_config_path
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def load(self) -> RuntimeConfig:
        if not self.path.exists():
            default = RuntimeConfig(
                filter_enabled=self.settings.default_filter_enabled,
                fail_closed=self.settings.default_fail_closed,
                mask_strategy=self.settings.default_mask_strategy,
                default_provider_id=self.settings.default_provider_id,
                providers={
                    provider_id: ProviderConfig.model_validate(provider)
                    for provider_id, provider in self.settings.build_provider_catalog().items()
                },
            )
            self.save(default)
            return default

        loaded = RuntimeConfig.model_validate_json(self.path.read_text(encoding="utf-8"))
        if not loaded.providers:
            loaded.providers = {
                provider_id: ProviderConfig.model_validate(provider)
                for provider_id, provider in self.settings.build_provider_catalog().items()
            }
        if loaded.default_provider_id not in loaded.providers:
            loaded.default_provider_id = self.settings.default_provider_id
        return loaded

    def save(self, config: RuntimeConfig) -> RuntimeConfig:
        self.path.write_text(config.model_dump_json(indent=2), encoding="utf-8")
        return config


class AuditRepository:
    def __init__(self) -> None:
        self.settings = get_settings()
        self.path: Path = self.settings.audit_log_path
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def append(self, record: AuditRecord) -> None:
        with self.path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record.model_dump(mode="json"), ensure_ascii=False) + "\n")

    def list_recent(self, limit: int = 100) -> list[dict]:
        if not self.path.exists():
            return []
        lines = self.path.read_text(encoding="utf-8").splitlines()
        return [json.loads(line) for line in lines[-limit:]][::-1]

    def now(self) -> datetime:
        return datetime.now(timezone.utc)
