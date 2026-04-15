from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse

from app.routes.admin import router as admin_router
from app.routes.extension import router as extension_router
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

    # CORS — exposed so the Chrome MV3 browser extension can call
    # `/v1/extension/sanitize` from its content script. Edge and Brave
    # use the same ``chrome-extension://`` origin scheme; Firefox uses
    # ``moz-extension://`` but this project explicitly targets Chromium
    # only (TODO.md Milestone 7) so we do not widen the allow-list for
    # it. The ``allow_origin_regex`` handles the per-install extension
    # ID that Chrome generates (which varies across developers and
    # across install modes — "load unpacked" produces a different ID
    # than a Chrome Web Store install would) by matching the scheme
    # rather than an explicit ID.
    #
    # The plain list entry is a belt-and-braces fallback; Starlette's
    # CORSMiddleware normally honours either ``allow_origins`` OR
    # ``allow_origin_regex``, and the regex is what actually matches
    # the real ``chrome-extension://<id>`` origin that Chrome sends.
    # ``POST`` covers the sanitize call itself and ``OPTIONS`` covers
    # the preflight; ``Content-Type`` is the only non-CORS-safelisted
    # header the extension attaches.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["chrome-extension://*"],
        allow_origin_regex=r"chrome-extension://.*",
        allow_methods=["POST", "OPTIONS"],
        allow_headers=["Content-Type"],
    )

    app.include_router(admin_router, prefix="/admin", tags=["admin"])
    app.include_router(sanitize_router, prefix="/sanitize", tags=["sanitize"])
    app.include_router(proxy_router, prefix="/proxy", tags=["proxy"])
    app.include_router(extension_router, prefix="/v1/extension", tags=["extension"])

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
