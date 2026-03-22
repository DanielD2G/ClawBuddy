"""Cron service — manages scheduled jobs.

Replaces: apps/api/src/services/cron.service.ts

Uses ARQ for job scheduling instead of BullMQ repeatable jobs.
Cron scheduling is handled by croniter + ARQ enqueue.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from croniter import croniter
from loguru import logger
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from clawbuddy.db.models import CronJob


# Builtin cron jobs
BUILTIN_CRON_JOBS: list[dict[str, Any]] = [
    {
        "name": "Stop Idle Workspace Containers",
        "description": "Stops workspace Docker containers idle for more than 10 minutes",
        "schedule": "*/5 * * * *",
        "type": "internal",
        "handler": "cleanupIdleContainers",
        "builtin": True,
    },
]


class CronService:
    """Manages cron jobs — CRUD, scheduling, and builtin registration."""

    async def list_jobs(self, db: AsyncSession) -> list[CronJob]:
        """List all cron jobs."""
        result = await db.execute(
            select(CronJob).order_by(CronJob.created_at.asc())
        )
        return list(result.scalars().all())

    async def get_by_id(self, db: AsyncSession, job_id: str) -> CronJob:
        """Get a cron job by ID."""
        result = await db.execute(
            select(CronJob).where(CronJob.id == job_id)
        )
        return result.scalar_one()

    async def create(
        self,
        db: AsyncSession,
        *,
        name: str,
        schedule: str,
        description: str | None = None,
        job_type: str = "agent",
        handler: str | None = None,
        prompt: str | None = None,
        workspace_id: str | None = None,
        session_id: str | None = None,
        enabled: bool = True,
    ) -> CronJob:
        """Create a new cron job."""
        # Validate cron expression
        if not croniter.is_valid(schedule):
            raise ValueError(f"Invalid cron expression: {schedule}")

        cron_job = CronJob(
            name=name,
            description=description,
            schedule=schedule,
            type=job_type,
            handler=handler,
            prompt=prompt,
            workspace_id=workspace_id,
            session_id=session_id,
            enabled=enabled,
        )
        db.add(cron_job)
        await db.commit()
        await db.refresh(cron_job)

        if cron_job.enabled:
            await self._schedule_job(cron_job)

        return cron_job

    async def update(
        self,
        db: AsyncSession,
        job_id: str,
        **kwargs: Any,
    ) -> CronJob:
        """Update a cron job."""
        result = await db.execute(
            select(CronJob).where(CronJob.id == job_id)
        )
        cron_job = result.scalar_one()

        # Validate schedule if changed
        if "schedule" in kwargs and kwargs["schedule"]:
            if not croniter.is_valid(kwargs["schedule"]):
                raise ValueError(f"Invalid cron expression: {kwargs['schedule']}")

        for key, value in kwargs.items():
            if hasattr(cron_job, key):
                setattr(cron_job, key, value)

        await db.commit()
        await db.refresh(cron_job)

        return cron_job

    async def delete_job(self, db: AsyncSession, job_id: str) -> None:
        """Delete a cron job (only non-builtin)."""
        result = await db.execute(
            select(CronJob).where(CronJob.id == job_id)
        )
        cron_job = result.scalar_one()

        if cron_job.builtin:
            raise ValueError("Cannot delete built-in cron jobs")

        await db.delete(cron_job)
        await db.commit()

    async def toggle_enabled(
        self, db: AsyncSession, job_id: str, enabled: bool
    ) -> CronJob:
        """Toggle a cron job's enabled state."""
        result = await db.execute(
            select(CronJob).where(CronJob.id == job_id)
        )
        cron_job = result.scalar_one()
        cron_job.enabled = enabled
        await db.commit()
        await db.refresh(cron_job)
        return cron_job

    async def register_builtin_jobs(self, db: AsyncSession) -> None:
        """Register builtin cron jobs on server startup."""
        # Remove old builtin cron jobs that have been replaced
        await db.execute(
            delete(CronJob).where(
                CronJob.handler == "cleanupStaleSandboxes",
                CronJob.builtin.is_(True),
            )
        )
        await db.commit()

        for builtin in BUILTIN_CRON_JOBS:
            result = await db.execute(
                select(CronJob).where(
                    CronJob.handler == builtin["handler"],
                    CronJob.builtin.is_(True),
                )
            )
            existing = result.scalar_one_or_none()

            if not existing:
                cron_job = CronJob(**builtin)
                db.add(cron_job)

        await db.commit()
        logger.info(f"[Cron] Registered {len(BUILTIN_CRON_JOBS)} builtin jobs")

    async def trigger_now(self, db: AsyncSession, job_id: str) -> None:
        """Trigger a cron job for immediate execution."""
        result = await db.execute(
            select(CronJob).where(CronJob.id == job_id)
        )
        cron_job = result.scalar_one()
        await self._enqueue_job(cron_job.id)

    async def tick(self, db: AsyncSession) -> None:
        """Check all enabled cron jobs and enqueue any that are due.

        Called periodically by the ARQ scheduler (e.g. every minute).
        """
        now = datetime.now(timezone.utc)

        result = await db.execute(
            select(CronJob).where(CronJob.enabled.is_(True))
        )
        jobs = result.scalars().all()

        for job in jobs:
            if not job.schedule:
                continue

            try:
                cron = croniter(job.schedule, job.last_run_at or job.created_at)
                next_run = cron.get_next(datetime)

                # Make next_run timezone-aware if needed
                if next_run.tzinfo is None:
                    next_run = next_run.replace(tzinfo=timezone.utc)

                if next_run <= now:
                    logger.info(f'[Cron] Triggering "{job.name}" (due at {next_run})')
                    await self._enqueue_job(job.id)
            except Exception as exc:
                logger.error(
                    f'[Cron] Failed to check schedule for "{job.name}": {exc}'
                )

    async def _schedule_job(self, cron_job: CronJob) -> None:
        """Schedule a cron job. With ARQ, we rely on periodic tick()."""
        # ARQ doesn't have built-in repeatable jobs like BullMQ.
        # Instead, we use a periodic tick() function that checks schedules.
        logger.debug(f'[Cron] Job "{cron_job.name}" scheduled: {cron_job.schedule}')

    async def _enqueue_job(self, cron_job_id: str) -> None:
        """Enqueue a cron job for immediate execution via ARQ."""
        from arq import create_pool
        from arq.connections import RedisSettings

        from clawbuddy.settings import settings

        redis_settings = RedisSettings(
            host=settings.redis_host,
            port=settings.redis_port,
        )
        pool = await create_pool(redis_settings)
        await pool.enqueue_job("execute_cron_job", cron_job_id)
        await pool.close()


cron_service = CronService()
