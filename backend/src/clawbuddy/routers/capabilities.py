"""Capabilities router — manage workspace capabilities and admin sandbox ops.

Replaces: apps/api/src/routes/capabilities.ts
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from clawbuddy.db.models import (
    Capability,
    SandboxSession,
    Workspace,
)
from clawbuddy.db.session import get_db
from clawbuddy.lib.responses import fail, ok
from clawbuddy.services.capability import capability_service

router = APIRouter(tags=["capabilities"])


# ── Public endpoints ──────────────────────────────────────


@router.get("/capabilities")
async def list_capabilities(db: AsyncSession = Depends(get_db)):
    """List all registered capabilities."""
    capabilities = await capability_service.list_all(db)
    return ok([
        {
            "id": c.id,
            "slug": c.slug,
            "name": c.name,
            "description": c.description,
            "icon": c.icon,
            "category": c.category,
            "builtin": c.builtin,
        }
        for c in capabilities
    ])


@router.get("/workspaces/{workspace_id}/capabilities")
async def get_workspace_capabilities(
    workspace_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Get all workspace capabilities (enabled and disabled) for management."""
    capabilities = await capability_service.get_workspace_capability_settings(
        db, workspace_id
    )
    return ok(capabilities)


@router.post("/workspaces/{workspace_id}/capabilities", status_code=201)
async def enable_capability(
    workspace_id: str,
    body: dict[str, Any],
    db: AsyncSession = Depends(get_db),
):
    """Enable a capability for a workspace."""
    slug = body.get("slug")
    config = body.get("config")

    if not slug:
        return fail("slug is required", status_code=400)

    try:
        wc = await capability_service.enable_capability(
            db, workspace_id, slug, config
        )
        return ok({
            "id": wc.id,
            "capabilityId": wc.capability_id,
            "workspaceId": wc.workspace_id,
            "enabled": wc.enabled,
        })
    except ValueError as exc:
        return fail(str(exc), status_code=400)


@router.delete("/workspaces/{workspace_id}/capabilities/{cap_id}")
async def disable_capability(
    workspace_id: str,
    cap_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Disable a capability for a workspace."""
    await capability_service.disable_capability(db, workspace_id, cap_id)
    return ok({"disabled": True})


@router.patch("/workspaces/{workspace_id}/capabilities/{cap_id}")
async def update_capability_config(
    workspace_id: str,
    cap_id: str,
    body: dict[str, Any],
    db: AsyncSession = Depends(get_db),
):
    """Update the configuration of a workspace capability."""
    config = body.get("config")
    if config is None:
        return fail("config is required", status_code=400)

    try:
        wc = await capability_service.update_capability_config(
            db, workspace_id, cap_id, config
        )
        return ok({
            "id": wc.id,
            "capabilityId": wc.capability_id,
            "enabled": wc.enabled,
        })
    except (ValueError, AttributeError) as exc:
        return fail(str(exc), status_code=400)


# ── Admin endpoints ───────────────────────────────────────


@router.post("/admin/capabilities", status_code=201)
async def create_custom_capability(
    body: dict[str, Any],
    db: AsyncSession = Depends(get_db),
):
    """Create a custom (non-builtin) capability."""
    required = ["slug", "name", "description", "toolDefinitions", "systemPrompt"]
    missing = [f for f in required if not body.get(f)]
    if missing:
        return fail(f"Missing required fields: {', '.join(missing)}", status_code=400)

    capability = Capability(
        slug=body["slug"],
        name=body["name"],
        description=body["description"],
        icon=body.get("icon"),
        category=body.get("category", "general"),
        tool_definitions=body["toolDefinitions"],
        system_prompt=body["systemPrompt"],
        docker_image=body.get("dockerImage"),
        packages=body.get("packages", []),
        network_access=body.get("networkAccess", False),
        config_schema=body.get("configSchema"),
        builtin=False,
    )
    db.add(capability)
    await db.commit()
    await db.refresh(capability)

    return ok({
        "id": capability.id,
        "slug": capability.slug,
        "name": capability.name,
    })


@router.get("/admin/sandboxes")
async def list_sandboxes(db: AsyncSession = Depends(get_db)):
    """List active sandbox sessions."""
    result = await db.execute(
        select(SandboxSession)
        .options(
            selectinload(SandboxSession.workspace),
            selectinload(SandboxSession.chat_session),
        )
        .where(SandboxSession.status.in_(["pending", "running"]))
        .order_by(SandboxSession.created_at.desc())
    )
    sandboxes = result.scalars().all()

    return ok([
        {
            "id": s.id,
            "status": s.status,
            "containerId": s.container_id,
            "createdAt": s.created_at.isoformat() if s.created_at else None,
            "workspace": {
                "id": s.workspace.id,
                "name": s.workspace.name,
            } if s.workspace else None,
            "chatSession": {
                "id": s.chat_session.id,
                "title": s.chat_session.title,
            } if s.chat_session else None,
        }
        for s in sandboxes
    ])


@router.delete("/admin/sandboxes/{sandbox_id}")
async def destroy_sandbox(
    sandbox_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Destroy a sandbox session."""
    from clawbuddy.services.sandbox import sandbox_service

    await sandbox_service.destroy_sandbox(sandbox_id, db)
    return ok({"destroyed": True})
