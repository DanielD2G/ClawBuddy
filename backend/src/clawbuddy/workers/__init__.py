"""ARQ background workers.

Replaces BullMQ workers from the TypeScript codebase.

To run the worker:
    uv run arq clawbuddy.workers.WorkerSettings
"""

from __future__ import annotations

from typing import Any

from arq.connections import RedisSettings

from clawbuddy.settings import settings
from clawbuddy.workers.cron_worker import execute_cron_job
from clawbuddy.workers.ingestion_worker import process_document


async def startup(ctx: dict[str, Any]) -> None:
    """ARQ worker startup hook."""
    from loguru import logger

    logger.info("[ARQ] Worker starting up...")


async def shutdown(ctx: dict[str, Any]) -> None:
    """ARQ worker shutdown hook."""
    from loguru import logger

    logger.info("[ARQ] Worker shutting down...")


async def cron_tick(ctx: dict[str, Any]) -> None:
    """Periodic task that checks cron schedules and enqueues due jobs.

    Runs every 60 seconds via ARQ's cron support.
    """
    from clawbuddy.db.session import async_session_factory
    from clawbuddy.services.cron import cron_service

    async with async_session_factory() as db:
        await cron_service.tick(db)


class WorkerSettings:
    """ARQ worker configuration."""

    redis_settings = RedisSettings(
        host=settings.redis_host,
        port=settings.redis_port,
    )

    functions = [
        process_document,
        execute_cron_job,
    ]

    on_startup = startup
    on_shutdown = shutdown

    # Run cron_tick every 60 seconds
    cron_jobs = [
        {
            "coroutine": cron_tick,
            "minute": None,  # Every minute
            "second": 0,
        },
    ]

    # Concurrency settings
    max_jobs = 5
    job_timeout = 600  # 10 minutes max per job
