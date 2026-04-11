from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, File, Header, HTTPException, UploadFile

from app.config import get_admin_token, get_settings
from app.models.schemas import SanitizeResponse, TextSanitizeRequest
from app.services.document_service import DocumentService
from app.services.masking_service import MaskingService
from app.services.ocr_service import OcrService
from app.services.repositories import AuditRepository, ConfigRepository

router = APIRouter()
settings = get_settings()  # still needed for settings.temp_dir below
service = MaskingService(ConfigRepository(), AuditRepository())
document_service = DocumentService()
ocr_service = OcrService()


def _authorize(token: str | None) -> None:
    expected = f"Bearer {get_admin_token()}"
    if token != expected:
        raise HTTPException(status_code=401, detail="invalid admin token")


@router.post("/text", response_model=SanitizeResponse)
async def sanitize_text(
    payload: TextSanitizeRequest,
    authorization: str | None = Header(default=None),
) -> SanitizeResponse:
    _authorize(authorization)
    return service.sanitize_text(payload)


@router.post("/file")
async def sanitize_file(
    upload: UploadFile = File(...),
    authorization: str | None = Header(default=None),
) -> dict:
    _authorize(authorization)

    settings.temp_dir.mkdir(parents=True, exist_ok=True)
    temp_path = settings.temp_dir / upload.filename
    temp_path.write_bytes(await upload.read())

    suffix = Path(upload.filename).suffix.lower()
    if suffix == ".pdf":
        text, meta = document_service.extract_text_from_pdf(temp_path)
        if document_service.needs_ocr(text):
            # PoC段階ではページ画像化OCRを未実装とし、TODOを返す
            meta["ocr_status"] = "todo"
        result = service.sanitize_text(TextSanitizeRequest(text=text))
        return {
            "filename": upload.filename,
            "kind": "pdf",
            "meta": meta,
            "audit_id": result.audit_id,
            "sanitized_preview": result.sanitized_text[:1000],
            "detections": [item.model_dump() for item in result.detections],
        }

    if suffix in {".png", ".jpg", ".jpeg", ".bmp", ".webp"}:
        text = ocr_service.extract_text_from_image(temp_path)
        result = service.sanitize_text(TextSanitizeRequest(text=text))
        return {
            "filename": upload.filename,
            "kind": "image",
            "audit_id": result.audit_id,
            "sanitized_preview": result.sanitized_text[:1000],
            "detections": [item.model_dump() for item in result.detections],
        }

    raise HTTPException(status_code=400, detail="unsupported file type")
