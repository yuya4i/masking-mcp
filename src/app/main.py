from fastapi import FastAPI

from app.routes.admin import router as admin_router
from app.routes.proxy import router as proxy_router
from app.routes.sanitize import router as sanitize_router


def create_app() -> FastAPI:
    app = FastAPI(title="Local Mask MCP Gateway", version="0.1.0")
    app.include_router(admin_router, prefix="/admin", tags=["admin"])
    app.include_router(sanitize_router, prefix="/sanitize", tags=["sanitize"])
    app.include_router(proxy_router, prefix="/proxy", tags=["proxy"])

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
