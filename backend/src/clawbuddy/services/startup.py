"""Startup service — health checks and initialization sequencing.

Replaces: apps/api/src/services/startup.service.ts

Runs critical startup checks (PostgreSQL, Redis, Qdrant, MinIO, etc.)
in order, retrying until all pass. Once ready, boots Telegram channels
and reconciles any active update runs.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any, Callable, Coroutine, Literal

import redis.asyncio as aioredis
from loguru import logger

from clawbuddy.settings import settings as env

STARTUP_RETRY_DELAY_S = 5

CRITICAL_CHECKS: list[str] = [
    "postgres",
    "redis",
    "qdrant",
    "minio",
    "settings",
    "capabilities",
    "skills",
    "toolDiscovery",
    "cron",
]

CheckStatus = Literal["pending", "ready", "error"]
StartupPhase = Literal["starting", "retrying", "ready"]


class StartupError(Exception):
    """Error raised during a specific startup check."""

    def __init__(self, check: str, message: str) -> None:
        super().__init__(message)
        self.check = check


def _create_checks(status: CheckStatus = "pending") -> dict[str, CheckStatus]:
    return {c: status for c in CRITICAL_CHECKS}


def _err_msg(error: object) -> str:
    return str(error) if isinstance(error, Exception) else str(error)


class StartupService:
    """Manages startup health checks and initialization."""

    def __init__(self) -> None:
        self._ready = False
        self._phase: StartupPhase = "starting"
        self._attempt = 0
        self._started_at = datetime.now(timezone.utc).isoformat()
        self._last_ready_at: str | None = None
        self._last_error: dict[str, str] | None = None
        self._checks: dict[str, CheckStatus] = _create_checks()
        self._bootstrap_task: asyncio.Task[None] | None = None
        self._booted_telegram = False

    def get_state(self) -> dict[str, Any]:
        """Return a snapshot of the current startup state."""
        return {
            "ready": self._ready,
            "phase": self._phase,
            "attempt": self._attempt,
            "started_at": self._started_at,
            "last_ready_at": self._last_ready_at,
            "last_error": dict(self._last_error) if self._last_error else None,
            "checks": dict(self._checks),
        }

    def start(self) -> asyncio.Task[None]:
        """Kick off the bootstrap loop (idempotent)."""
        if self._bootstrap_task is None:
            self._bootstrap_task = asyncio.create_task(self._bootstrap_loop())
        return self._bootstrap_task

    async def _bootstrap_loop(self) -> None:
        """Run checks in a retry loop until all pass."""
        while True:
            self._attempt += 1
            self._phase = "starting" if self._attempt == 1 else "retrying"
            self._ready = False
            self._checks = _create_checks()

            try:
                await self._run_check("postgres", self._check_postgres)
                await self._run_migrations()
                await self._run_check("redis", self._check_redis)
                await self._run_check("qdrant", self._check_qdrant)
                await self._run_check("minio", self._check_minio)
                await self._run_check("settings", self._check_settings)
                await self._run_check("capabilities", self._check_capabilities)
                await self._run_check("skills", self._check_skills)
                await self._run_check("toolDiscovery", self._check_tool_discovery)
                await self._run_check("cron", self._check_cron)

                self._ready = True
                self._phase = "ready"
                self._last_ready_at = datetime.now(timezone.utc).isoformat()
                self._last_error = None

                logger.info(
                    f"[Startup] All checks passed (attempt {self._attempt})"
                )

                # Fire-and-forget background tasks
                asyncio.create_task(self._boot_telegram_channels())
                asyncio.create_task(self._reconcile_updates())
                return

            except StartupError as exc:
                self._ready = False
                self._phase = "retrying"
                self._last_error = {
                    "check": exc.check,
                    "message": str(exc),
                    "at": datetime.now(timezone.utc).isoformat(),
                }
                logger.error(
                    f"[Startup] Attempt {self._attempt} failed during "
                    f"{exc.check}: {exc}"
                )
                await asyncio.sleep(STARTUP_RETRY_DELAY_S)
            except Exception as exc:
                self._ready = False
                self._phase = "retrying"
                self._last_error = {
                    "check": "postgres",
                    "message": _err_msg(exc),
                    "at": datetime.now(timezone.utc).isoformat(),
                }
                logger.error(
                    f"[Startup] Attempt {self._attempt} failed: {exc}"
                )
                await asyncio.sleep(STARTUP_RETRY_DELAY_S)

    async def _run_check(
        self,
        check: str,
        fn: Callable[[], Coroutine[Any, Any, None]],
    ) -> None:
        """Run a single check, updating status."""
        try:
            await fn()
            self._checks[check] = "ready"
        except Exception as exc:
            self._checks[check] = "error"
            raise StartupError(check, _err_msg(exc)) from exc

    # ── Database migrations ─────────────────────────────

    async def _run_migrations(self) -> None:
        """Apply pending Alembic migrations automatically.

        Uses subprocess to avoid asyncio.run() conflicts with the
        already-running event loop.
        """
        import subprocess
        import sys

        logger.info("[Startup] Running Alembic migrations...")

        try:
            result = await asyncio.to_thread(
                subprocess.run,
                [sys.executable, "-m", "alembic", "upgrade", "head"],
                capture_output=True,
                text=True,
                env={
                    **__import__("os").environ,
                    "DATABASE_URL": env.DATABASE_URL,
                },
            )
            if result.returncode != 0:
                stderr = result.stderr.strip()
                raise RuntimeError(f"alembic upgrade failed:\n{stderr}")
            logger.info("[Startup] Migrations applied successfully")
        except Exception as exc:
            logger.error(f"[Startup] Migration failed: {exc}")
            raise StartupError("migrations", str(exc)) from exc

    # ── Individual checks ────────────────────────────────

    async def _check_postgres(self) -> None:
        from sqlalchemy import text
        from clawbuddy.db.session import async_session_factory

        async with async_session_factory() as db:
            await db.execute(text("SELECT 1"))

    async def _check_redis(self) -> None:
        r = aioredis.Redis(
            host=env.redis_host,
            port=env.redis_port,
            socket_connect_timeout=5,
        )
        try:
            pong = await r.ping()
            if not pong:
                raise RuntimeError("Redis ping returned False")
        finally:
            await r.aclose()

    async def _check_qdrant(self) -> None:
        from clawbuddy.lib.qdrant import qdrant

        await qdrant.get_collections()

    async def _check_minio(self) -> None:
        from clawbuddy.services.storage import storage_service

        await storage_service.ensure_bucket_exists()

    async def _check_settings(self) -> None:
        from sqlalchemy import select
        from clawbuddy.db.models import GlobalSettings
        from clawbuddy.db.session import async_session_factory
        from clawbuddy.services.settings_service import settings_service

        async with async_session_factory() as db:
            result = await db.execute(
                select(GlobalSettings).where(GlobalSettings.id == "singleton")
            )
            if not result.scalar_one_or_none():
                gs = GlobalSettings(id="singleton")
                db.add(gs)
                await db.commit()

        await settings_service.get()

    async def _check_capabilities(self) -> None:
        from clawbuddy.db.session import async_session_factory
        from clawbuddy.services.capability import capability_service

        async with async_session_factory() as db:
            await capability_service.sync_builtin_capabilities(db)

    async def _check_skills(self) -> None:
        from clawbuddy.db.session import async_session_factory
        from clawbuddy.services.skill import skill_service

        async with async_session_factory() as db:
            await skill_service.sync_skills_from_storage(db, throw_on_error=True)

    async def _check_tool_discovery(self) -> None:
        from clawbuddy.services.settings_service import settings_service

        s = await settings_service.get()
        if not s.get("onboardingComplete"):
            return
        from clawbuddy.services.tool_discovery import tool_discovery_service

        await tool_discovery_service.index_capabilities()

    async def _check_cron(self) -> None:
        from clawbuddy.db.session import async_session_factory
        from clawbuddy.services.cron import cron_service

        async with async_session_factory() as db:
            await cron_service.register_builtin_jobs(db)

    # ── Post-ready tasks ─────────────────────────────────

    async def _boot_telegram_channels(self) -> None:
        if self._booted_telegram:
            return
        self._booted_telegram = True

        try:
            from clawbuddy.channels.telegram.bot_manager import telegram_bot_manager
            from clawbuddy.db.session import async_session_factory
            from clawbuddy.services.channel import channel_service
            from clawbuddy.services.crypto import decrypt

            async with async_session_factory() as db:
                channels = await channel_service.get_all_enabled(db)
                for channel in channels:
                    if channel.type != "telegram":
                        continue
                    try:
                        config = dict(channel.config) if channel.config else {}
                        bot_token = decrypt(config["botToken"])
                        await telegram_bot_manager.start_bot(
                            channel.id, bot_token, channel.workspace_id
                        )
                    except Exception as exc:
                        logger.error(
                            f"[Telegram] Failed to start bot for channel "
                            f"{channel.id}: {exc}"
                        )
        except Exception as exc:
            logger.error(f"[Telegram] Failed to boot channels: {exc}")

    async def _reconcile_updates(self) -> None:
        try:
            from clawbuddy.services.update import update_service

            await update_service.reconcile_active_run()
        except Exception as exc:
            logger.error(
                f"[Update] Failed to reconcile active run: {exc}"
            )


startup_service = StartupService()
