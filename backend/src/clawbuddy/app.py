"""FastAPI application factory.

Replaces: apps/api/src/app.ts
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from collections.abc import AsyncGenerator
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from loguru import logger

from clawbuddy.db.session import close_engine
from clawbuddy.lib.build_info import get_build_info
from clawbuddy.middleware.error_handler import register_error_handlers
from clawbuddy.settings import settings


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Application lifespan handler for startup and shutdown."""
    # ── Startup ──────────────────────────────────────────
    logger.info("[Server] Starting ClawBuddy API...")

    # Import and start services lazily to avoid circular imports
    from clawbuddy.services.startup import startup_service

    await startup_service.start()

    # Start periodic browser cleanup task
    import asyncio

    async def _browser_cleanup_loop() -> None:
        while True:
            try:
                await asyncio.sleep(60)
                from clawbuddy.services.browser import browser_service

                await browser_service.cleanup_idle_sessions()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"[Browser] Cleanup error: {e}")

    cleanup_task = asyncio.create_task(_browser_cleanup_loop())

    yield

    # ── Shutdown ─────────────────────────────────────────
    logger.info("[Server] Shutting down...")
    cleanup_task.cancel()
    try:
        await cleanup_task
    except asyncio.CancelledError:
        pass

    # Graceful shutdown of services
    try:
        from clawbuddy.services.browser import browser_service

        await browser_service.shutdown()
    except Exception as e:
        logger.error(f"[Shutdown] Browser service error: {e}")

    try:
        from clawbuddy.channels.telegram.bot_manager import telegram_bot_manager

        await telegram_bot_manager.stop_all()
    except Exception as e:
        logger.error(f"[Shutdown] Telegram bot manager error: {e}")

    await close_engine()
    logger.info("[Server] Shutdown complete.")


def create_app() -> FastAPI:
    """Create and configure the FastAPI application."""
    app = FastAPI(
        title="ClawBuddy API",
        version="0.1.0",
        docs_url="/api/docs",
        redoc_url="/api/redoc",
        openapi_url="/api/openapi.json",
        lifespan=lifespan,
        default_response_class=_get_orjson_response(),
    )

    # ── CORS ─────────────────────────────────────────────
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[settings.APP_URL],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ── Error handlers ───────────────────────────────────
    register_error_handlers(app)

    # ── Health check ─────────────────────────────────────
    @app.get("/api/health", tags=["System"])
    async def health_check() -> dict[str, Any]:
        from clawbuddy.services.startup import startup_service

        state = startup_service.get_state()
        build = get_build_info()

        return {
            "success": state["ready"],
            "data": {
                "version": build["version"],
                "commitSha": build["commit_sha"],
                "builtAt": build["built_at"],
                "status": "ok" if state["ready"] else "starting",
                "phase": state["phase"],
                "attempt": state["attempt"],
                "startedAt": state["started_at"],
                "lastReadyAt": state["last_ready_at"],
                "lastError": state["last_error"],
                "checks": state["checks"],
            },
        }

    # ── Mount routers ────────────────────────────────────
    _mount_routers(app)

    return app


def _mount_routers(app: FastAPI) -> None:
    """Mount all API routers."""
    from clawbuddy.routers import (
        admin,
        browser,
        capabilities,
        channels,
        chat,
        cron,
        documents,
        files,
        folders,
        oauth,
        search,
        settings_router,
        setup,
        skills,
        stats,
        update,
        workspaces,
    )

    app.include_router(setup.router, prefix="/api/setup", tags=["Setup"])
    app.include_router(workspaces.router, prefix="/api/workspaces", tags=["Workspaces"])
    app.include_router(folders.router, prefix="/api", tags=["Folders"])
    app.include_router(documents.router, prefix="/api", tags=["Documents"])
    app.include_router(search.router, prefix="/api", tags=["Search"])
    app.include_router(chat.router, prefix="/api", tags=["Chat"])
    app.include_router(stats.router, prefix="/api", tags=["Stats"])
    app.include_router(settings_router.router, prefix="/api", tags=["Settings"])
    app.include_router(admin.router, prefix="/api", tags=["Admin"])
    app.include_router(capabilities.router, prefix="/api", tags=["Capabilities"])
    app.include_router(files.router, prefix="/api", tags=["Files"])
    app.include_router(skills.router, prefix="/api", tags=["Skills"])
    app.include_router(cron.router, prefix="/api", tags=["Cron"])
    app.include_router(oauth.router, prefix="/api/oauth", tags=["OAuth"])
    app.include_router(browser.router, prefix="/api/browser", tags=["Browser"])
    app.include_router(channels.router, prefix="/api/channels", tags=["Channels"])
    app.include_router(update.router, prefix="/api", tags=["Update"])


def _get_orjson_response():  # type: ignore[no-untyped-def]
    """Get ORJSONResponse class for default responses."""
    from fastapi.responses import ORJSONResponse

    return ORJSONResponse
