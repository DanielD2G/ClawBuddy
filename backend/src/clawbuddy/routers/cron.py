"""Cron router — manage scheduled cron jobs.

Replaces: apps/api/src/routes/cron.ts
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from clawbuddy.db.session import get_db
from clawbuddy.lib.responses import fail, ok
from clawbuddy.services.cron import cron_service

router = APIRouter(tags=["cron"])


@router.get("/admin/cron")
async def list_cron_jobs(db: AsyncSession = Depends(get_db)):
    """List all cron jobs."""
    jobs = await cron_service.list_jobs(db)
    return ok([
        {
            "id": j.id,
            "name": j.name,
            "description": j.description,
            "schedule": j.schedule,
            "type": j.type,
            "handler": j.handler,
            "prompt": j.prompt,
            "workspaceId": j.workspace_id,
            "sessionId": j.session_id,
            "enabled": j.enabled,
            "builtin": j.builtin,
            "lastRunAt": j.last_run_at.isoformat() if j.last_run_at else None,
            "lastRunStatus": j.last_run_status,
            "lastRunError": j.last_run_error,
            "createdAt": j.created_at.isoformat() if j.created_at else None,
        }
        for j in jobs
    ])


@router.post("/admin/cron", status_code=201)
async def create_cron_job(
    body: dict[str, Any],
    db: AsyncSession = Depends(get_db),
):
    """Create a new cron job."""
    try:
        job = await cron_service.create(
            db,
            name=body.get("name", ""),
            schedule=body.get("schedule", ""),
            description=body.get("description"),
            job_type=body.get("type", "agent"),
            handler=body.get("handler"),
            prompt=body.get("prompt"),
            workspace_id=body.get("workspaceId"),
            session_id=body.get("sessionId"),
            enabled=body.get("enabled", True),
        )
        return ok({
            "id": job.id,
            "name": job.name,
            "schedule": job.schedule,
            "enabled": job.enabled,
        })
    except ValueError as exc:
        return fail(str(exc), status_code=400)


@router.patch("/admin/cron/{job_id}")
async def update_cron_job(
    job_id: str,
    body: dict[str, Any],
    db: AsyncSession = Depends(get_db),
):
    """Update a cron job."""
    try:
        job = await cron_service.update(db, job_id, **body)
        return ok({
            "id": job.id,
            "name": job.name,
            "schedule": job.schedule,
            "enabled": job.enabled,
        })
    except ValueError as exc:
        return fail(str(exc), status_code=400)


@router.delete("/admin/cron/{job_id}")
async def delete_cron_job(
    job_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Delete a cron job (403 if builtin)."""
    try:
        await cron_service.delete_job(db, job_id)
        return ok(None)
    except ValueError as exc:
        if "built-in" in str(exc):
            return fail(str(exc), status_code=403)
        return fail(str(exc), status_code=400)


@router.patch("/admin/cron/{job_id}/toggle")
async def toggle_cron_job(
    job_id: str,
    body: dict[str, Any],
    db: AsyncSession = Depends(get_db),
):
    """Toggle a cron job enabled/disabled."""
    enabled = body.get("enabled", True)
    job = await cron_service.toggle_enabled(db, job_id, enabled)
    return ok({
        "id": job.id,
        "name": job.name,
        "enabled": job.enabled,
    })


@router.post("/admin/cron/{job_id}/trigger")
async def trigger_cron_job(
    job_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Trigger a cron job for immediate execution."""
    await cron_service.trigger_now(db, job_id)
    return ok(None)
