"""Skills router — upload, list, delete, and rebuild skill images.

Replaces: apps/api/src/routes/skills.ts
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from clawbuddy.db.session import get_db
from clawbuddy.lib.responses import fail, ok
from clawbuddy.lib.sse import create_sse_stream
from clawbuddy.services.skill import skill_service

router = APIRouter(tags=["skills"])


@router.post("/skills/upload")
async def upload_skill(
    body: dict[str, Any],
    db: AsyncSession = Depends(get_db),
):
    """Upload a .skill file.

    If it has an installation script, the endpoint streams build logs via SSE.
    """
    has_installation = bool(body.get("installation"))

    if has_installation:
        # Stream build logs via SSE
        async def handler(emit):
            def on_build_log(line: str) -> None:
                import asyncio

                # Use fire-and-forget since on_build_log is sync
                try:
                    loop = asyncio.get_running_loop()
                    loop.create_task(
                        emit("build_log", {"data": line})
                    )
                except RuntimeError:
                    pass

            result = await skill_service.upload_skill(
                json.dumps(body), db, on_build_log
            )

            if result.success:
                await emit("complete", {
                    "success": True,
                    "slug": result.slug,
                })
            else:
                await emit("error", {
                    "success": False,
                    "error": result.error,
                    "logs": result.logs,
                })

        return create_sse_stream(handler)

    # No installation script — simple JSON response
    result = await skill_service.upload_skill(json.dumps(body), db)
    if not result.success:
        return fail(
            result.error or "Upload failed",
            status_code=400,
        )
    return ok({"slug": result.slug})


@router.get("/skills")
async def list_skills(db: AsyncSession = Depends(get_db)):
    """List all installed skills."""
    skills = await skill_service.list_skills(db)
    return ok([
        {
            "id": s.id,
            "slug": s.slug,
            "name": s.name,
            "description": s.description,
            "icon": s.icon,
            "category": s.category,
            "version": s.version,
            "skillType": s.skill_type,
            "source": s.source,
        }
        for s in skills
    ])


@router.delete("/skills/{slug}")
async def delete_skill(
    slug: str,
    db: AsyncSession = Depends(get_db),
):
    """Delete a skill."""
    result = await skill_service.delete_skill(slug, db)
    if not result.success:
        return fail(result.error or "Delete failed", status_code=400)
    return ok({"deleted": True})


@router.post("/skills/rebuild-image")
async def rebuild_skill_image(
    body: dict[str, Any],
    db: AsyncSession = Depends(get_db),
):
    """Force rebuild the skill Docker image for a workspace."""
    workspace_id = body.get("workspaceId")
    if not workspace_id:
        return fail("workspaceId is required", status_code=400)

    async def handler(emit):
        try:
            from clawbuddy.services.image_builder import image_builder_service
            from clawbuddy.services.sandbox import sandbox_service

            await image_builder_service.invalidate_images()
            await emit("build_log", {"data": "Invalidated old images"})

            async def on_log_async(line: str) -> None:
                await emit("build_log", {"data": line})

            # on_log needs to be sync for the image builder, so use a wrapper
            import asyncio

            def on_log(line: str) -> None:
                try:
                    loop = asyncio.get_running_loop()
                    loop.create_task(emit("build_log", {"data": line}))
                except RuntimeError:
                    pass

            tag = await image_builder_service.get_or_build_image(
                workspace_id, db, on_log
            )

            await emit("build_log", {"data": "Stopping workspace container..."})
            try:
                await sandbox_service.stop_workspace_container(
                    workspace_id, db
                )
            except Exception:
                pass

            await emit("complete", {"success": True, "image": tag})
        except Exception as exc:
            message = str(exc) or "Failed to rebuild image"
            await emit("error", {"success": False, "error": message})

    return create_sse_stream(handler)
