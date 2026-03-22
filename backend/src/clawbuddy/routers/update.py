"""Update router — self-update management via Docker Swarm.

Replaces: apps/api/src/routes/update.ts
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from clawbuddy.lib.responses import fail, ok

router = APIRouter(tags=["update"])


@router.get("/update")
async def get_update_overview() -> Any:
    """Get current update status overview."""
    from clawbuddy.services.update import update_service

    return ok(await update_service.get_overview())


@router.post("/update/check")
async def check_for_updates() -> Any:
    """Force-check for new releases."""
    try:
        from clawbuddy.services.update import update_service

        return ok(await update_service.force_check())
    except Exception as exc:
        return fail(str(exc) or "Failed to refresh releases", status_code=500)


@router.post("/update/accept")
async def accept_update() -> Any:
    """Accept and start the latest release update."""
    try:
        from clawbuddy.services.update import update_service

        await update_service.accept_latest_release()
        return ok(await update_service.get_overview(force_release_refresh=True))
    except Exception as exc:
        return fail(str(exc) or "Failed to start update", status_code=409)


@router.post("/update/decline")
async def decline_update() -> Any:
    """Dismiss/decline the latest release."""
    try:
        from clawbuddy.services.update import update_service

        await update_service.decline_latest_release()
        return ok(await update_service.get_overview(force_release_refresh=True))
    except Exception as exc:
        return fail(str(exc) or "Failed to dismiss release", status_code=500)
