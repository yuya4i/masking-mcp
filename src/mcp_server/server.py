from __future__ import annotations

from mcp.server.fastmcp import FastMCP

from app.models.schemas import TextSanitizeRequest
from app.services.masking_service import MaskingService
from app.services.proxy_service import ProxyService
from app.services.repositories import AuditRepository, ConfigRepository

mcp = FastMCP("local-mask-mcp")
config_repo = ConfigRepository()
service = MaskingService(config_repo, AuditRepository())
proxy_service = ProxyService(config_repo)


@mcp.tool()
def sanitize_text(text: str, mask_strategy: str = "tag") -> dict:
    result = service.sanitize_text(
        TextSanitizeRequest(
            text=text,
            mask_strategy=mask_strategy if mask_strategy in {"tag", "partial", "hash"} else "tag",
        )
    )
    return result.model_dump(mode="json")


@mcp.tool()
def toggle_filter(enabled: bool) -> dict:
    config = config_repo.load()
    config.filter_enabled = enabled
    config_repo.save(config)
    return {"filter_enabled": config.filter_enabled}


@mcp.tool()
def set_provider(provider_id: str) -> dict:
    config = config_repo.load()
    if provider_id not in config.providers:
        raise ValueError(f"unknown provider: {provider_id}")
    if not config.providers[provider_id].enabled:
        raise ValueError(f"provider disabled: {provider_id}")
    config.default_provider_id = provider_id
    config_repo.save(config)
    return proxy_service.describe_provider(provider_id).model_dump(mode="json")


@mcp.tool()
def get_runtime_config() -> dict:
    config = config_repo.load()
    return {
        **config.model_dump(mode="json"),
        "selected_provider": proxy_service.describe_provider(config.default_provider_id).model_dump(mode="json"),
    }


if __name__ == "__main__":
    mcp.run()
