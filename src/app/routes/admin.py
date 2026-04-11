from fastapi import APIRouter, Header, HTTPException

from app.config import get_admin_token
from app.models.schemas import RuntimeConfig, ToggleRequest
from app.services.repositories import AuditRepository, ConfigRepository

router = APIRouter()
config_repo = ConfigRepository()
audit_repo = AuditRepository()


def _authorize(token: str | None) -> None:
    expected = f"Bearer {get_admin_token()}"
    if token != expected:
        raise HTTPException(status_code=401, detail="invalid admin token")


@router.get("/config", response_model=RuntimeConfig)
async def get_config(authorization: str | None = Header(default=None)) -> RuntimeConfig:
    _authorize(authorization)
    return config_repo.load()


@router.put("/config", response_model=RuntimeConfig)
async def update_config(
    payload: RuntimeConfig,
    authorization: str | None = Header(default=None),
) -> RuntimeConfig:
    _authorize(authorization)
    return config_repo.save(payload)


@router.post("/toggle", response_model=RuntimeConfig)
async def toggle_filter(
    payload: ToggleRequest,
    authorization: str | None = Header(default=None),
) -> RuntimeConfig:
    _authorize(authorization)
    config = config_repo.load()
    config.filter_enabled = payload.enabled
    return config_repo.save(config)


@router.get("/audits")
async def list_audits(authorization: str | None = Header(default=None)) -> list[dict]:
    _authorize(authorization)
    return audit_repo.list_recent(limit=100)
