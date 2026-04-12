from fastapi import FastAPI
from fastapi.responses import RedirectResponse

from app.routes.admin import router as admin_router
from app.routes.proxy import router as proxy_router
from app.routes.sanitize import router as sanitize_router


def create_app() -> FastAPI:
    app = FastAPI(
        title="Local Mask MCP Gateway",
        version="0.1.0",
        description=(
            "ローカル PII マスキングゲートウェイ。\n\n"
            "テキスト / ドキュメント内の個人情報 (固有名詞・メールアドレス・電話番号など) を"
            "検出してマスクし、LLM プロバイダへ安全に転送します。\n\n"
            "- **Presidio** (英語 NER + 正規表現)\n"
            "- **SudachiPy** (日本語形態素解析 → 固有名詞抽出)\n"
            "- **RegexAnalyzer** (ユーザ定義パターン)\n\n"
            "の 3 層アナライザを言語検出で自動切替、または `analyzers_by_language` で明示指定できます。"
        ),
        docs_url="/v1/api",
        redoc_url="/v1/api/redoc",
        openapi_url="/v1/api/openapi.json",
    )
    app.include_router(admin_router, prefix="/admin", tags=["admin"])
    app.include_router(sanitize_router, prefix="/sanitize", tags=["sanitize"])
    app.include_router(proxy_router, prefix="/proxy", tags=["proxy"])

    @app.get("/health", tags=["system"])
    async def health() -> dict[str, str]:
        """ヘルスチェック。認証不要。Docker HEALTHCHECK が使用。"""
        return {"status": "ok"}

    @app.get("/api", include_in_schema=False)
    @app.get("/docs", include_in_schema=False)
    async def redirect_to_docs() -> RedirectResponse:
        """ショートカット: /api や /docs でも Swagger UI に飛ばす。"""
        return RedirectResponse(url="/v1/api")

    return app


app = create_app()
