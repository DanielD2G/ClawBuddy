"""Workspace routes.

Replaces: apps/api/src/routes/workspaces.ts
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, status
from loguru import logger
from sqlalchemy.exc import NoResultFound
from sqlalchemy.ext.asyncio import AsyncSession

from clawbuddy.db.session import get_db
from clawbuddy.lib.responses import fail, ok
from clawbuddy.schemas.workspace import CreateWorkspaceInput, UpdateWorkspaceInput
from clawbuddy.schemas.workspace_export import WorkspaceExport
from clawbuddy.services.workspace import workspace_service

router = APIRouter(tags=["Workspaces"])


@router.get("")
async def list_workspaces(db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    workspaces = await workspace_service.list(db)
    return ok(workspace_service.serialize_many(workspaces))


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_workspace(
    body: CreateWorkspaceInput,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    workspace = await workspace_service.create(
        db,
        {
            "name": body.name,
            "description": body.description,
            "color": body.color,
            "settings": body.settings,
        },
    )
    return ok(workspace_service.serialize(workspace))


@router.post("/import", status_code=status.HTTP_201_CREATED)
async def import_workspace(
    body: WorkspaceExport,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Import a workspace from an export file."""
    from clawbuddy.services.capability import capability_service

    skipped_capabilities: list[str] = []
    warnings: list[str] = []

    # Create workspace
    workspace = await workspace_service.create(
        db,
        {
            "name": f"{body.workspace.name} (imported)",
            "description": body.workspace.description,
            "color": body.workspace.color,
            "settings": body.workspace.settings,
        },
    )

    # Apply permissions and autoExecute
    update_data: dict[str, Any] = {"autoExecute": body.workspace.auto_execute}
    if body.workspace.permissions:
        update_data["permissions"] = body.workspace.permissions
    await workspace_service.update(db, workspace.id, update_data)

    # Enable capabilities
    for cap in body.capabilities:
        if not cap.enabled:
            continue
        try:
            await capability_service.enable_capability(
                db, workspace.id, cap.slug, cap.config
            )
        except Exception:
            skipped_capabilities.append(cap.slug)

    # Create channels (disabled by default)
    from clawbuddy.services.channel import channel_service

    for ch in body.channels:
        try:
            config = ch.config
            if not config.get("botToken"):
                warnings.append(f'Channel "{ch.name}" skipped — no bot token')
                continue
            await channel_service.create(
                db,
                workspace_id=workspace.id,
                channel_type=ch.type,
                name=ch.name,
                config={"botToken": config["botToken"]},
            )
            warnings.append(
                f'Channel "{ch.name}" imported as disabled — enable it manually after testing'
            )
        except Exception:
            warnings.append(f'Failed to import channel "{ch.name}"')

    # Ensure always-on capabilities
    await capability_service.ensure_always_on_capabilities(db)

    return ok(
        {
            "workspace": workspace_service.serialize(workspace),
            "skippedCapabilities": skipped_capabilities,
            "warnings": warnings,
            "modelConfig": body.model_config_data.model_dump(by_alias=True),
        }
    )


@router.get("/{workspace_id}")
async def get_workspace(
    workspace_id: str,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    workspace = await workspace_service.find_by_id(db, workspace_id)
    if not workspace:
        return fail("Workspace not found", status_code=404)
    return ok(workspace_service.serialize(workspace))


@router.patch("/{workspace_id}")
async def update_workspace(
    workspace_id: str,
    body: UpdateWorkspaceInput,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    data: dict[str, Any] = {}
    if body.name is not None:
        data["name"] = body.name
    if body.description is not None:
        data["description"] = body.description
    if body.color is not None:
        data["color"] = body.color
    if body.permissions is not None:
        data["permissions"] = body.permissions.model_dump()
    if body.settings is not None:
        data["settings"] = body.settings
    if body.auto_execute is not None:
        data["autoExecute"] = body.auto_execute
    workspace = await workspace_service.update(db, workspace_id, data)
    return ok(workspace_service.serialize(workspace))


@router.delete("/{workspace_id}")
async def delete_workspace(
    workspace_id: str,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    try:
        from clawbuddy.services.sandbox import sandbox_service
        await sandbox_service.stop_workspace_container(workspace_id)
    except Exception as err:
        logger.warning(f"[Workspaces] Failed to stop container for workspace {workspace_id}: {err}")
    await workspace_service.delete(db, workspace_id)
    return ok({"id": workspace_id})


# ── Workspace Export ──────────────────────────────────────

@router.get("/{workspace_id}/export")
async def export_workspace(
    workspace_id: str,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    from clawbuddy.db.models import Channel, TokenUsage
    from clawbuddy.lib.llm_resolver import build_resolved_role_providers
    from clawbuddy.services.capability import capability_service
    from clawbuddy.services.config_validation import decrypt_config_fields
    from clawbuddy.services.crypto import decrypt
    from clawbuddy.services.settings_service import settings_service
    from sqlalchemy import func, select

    workspace = await workspace_service.find_by_id(db, workspace_id)
    if not workspace:
        return fail("Workspace not found", status_code=404)

    # Enabled capabilities with decrypted configs
    enabled_caps = await capability_service.get_enabled_capabilities_for_workspace(
        db, workspace_id
    )
    capabilities = []
    for cap in enabled_caps:
        schema = cap.get("configSchema")
        raw_config = cap.get("config")
        config = (
            decrypt_config_fields(schema, raw_config)
            if schema and raw_config
            else raw_config
        )
        capabilities.append({"slug": cap["slug"], "enabled": True, "config": config})

    # Channels with decrypted tokens
    ch_result = await db.execute(
        select(Channel).where(Channel.workspace_id == workspace_id)
    )
    raw_channels = ch_result.scalars().all()
    channels = []
    for ch in raw_channels:
        config = dict(ch.config or {})
        if config.get("botToken"):
            try:
                config["botToken"] = decrypt(config["botToken"])
            except Exception:
                pass
        channels.append(
            {"type": ch.type, "name": ch.name, "enabled": ch.enabled, "config": config}
        )

    # Global model config
    settings = await settings_service.get(db)
    model_config = {
        "aiProvider": settings["aiProvider"],
        "aiModel": settings["aiModel"],
        "roleProviders": build_resolved_role_providers(settings),
        "mediumModel": settings.get("mediumModel"),
        "lightModel": settings.get("lightModel"),
        "exploreModel": settings.get("exploreModel"),
        "executeModel": settings.get("executeModel"),
        "titleModel": settings.get("titleModel"),
        "compactModel": settings.get("compactModel"),
        "advancedModelConfig": settings.get("advancedModelConfig"),
        "embeddingProvider": settings["embeddingProvider"],
        "embeddingModel": settings.get("embeddingModel"),
        "localBaseUrl": settings.get("localBaseUrl"),
        "contextLimitTokens": settings.get("contextLimitTokens"),
        "maxAgentIterations": settings.get("maxAgentIterations"),
        "subAgentExploreMaxIterations": settings.get("subAgentExploreMaxIterations"),
        "subAgentAnalyzeMaxIterations": settings.get("subAgentAnalyzeMaxIterations"),
        "subAgentExecuteMaxIterations": settings.get("subAgentExecuteMaxIterations"),
        "timezone": settings.get("timezone"),
    }

    # Token usage summary
    usage_result = await db.execute(
        select(
            TokenUsage.provider,
            TokenUsage.model,
            func.sum(TokenUsage.input_tokens).label("input_sum"),
            func.sum(TokenUsage.output_tokens).label("output_sum"),
        ).group_by(TokenUsage.provider, TokenUsage.model)
    )
    usage_rows = usage_result.all()

    totals_result = await db.execute(
        select(
            func.sum(TokenUsage.input_tokens).label("input_sum"),
            func.sum(TokenUsage.output_tokens).label("output_sum"),
        )
    )
    totals = totals_result.one()

    token_usage = {
        "totalInputTokens": totals.input_sum or 0,
        "totalOutputTokens": totals.output_sum or 0,
        "byModel": [
            {
                "provider": row.provider,
                "model": row.model,
                "inputTokens": row.input_sum or 0,
                "outputTokens": row.output_sum or 0,
            }
            for row in usage_rows
        ],
    }

    from datetime import datetime, timezone

    export_data = {
        "version": 1,
        "exportedAt": datetime.now(timezone.utc).isoformat(),
        "workspace": {
            "name": workspace.name,
            "description": workspace.description,
            "color": workspace.color,
            "autoExecute": workspace.auto_execute,
            "settings": workspace.settings,
            "permissions": workspace.permissions,
        },
        "capabilities": capabilities,
        "channels": channels,
        "modelConfig": model_config,
        "tokenUsage": token_usage,
    }

    return ok(export_data)


# ── Workspace Capability Overrides ─────────────────────────

@router.get("/{workspace_id}/capabilities")
async def get_workspace_capabilities(
    workspace_id: str,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    from clawbuddy.services.capability import capability_service

    capabilities = await capability_service.get_workspace_capability_settings(
        db, workspace_id
    )
    return ok(capabilities)


@router.put("/{workspace_id}/capabilities/{capability_slug}")
async def update_workspace_capability(
    workspace_id: str,
    capability_slug: str,
    body: dict[str, Any],
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    from clawbuddy.services.capability import capability_service

    if body.get("enabled"):
        await capability_service.enable_capability(
            db, workspace_id, capability_slug, body.get("config")
        )
    else:
        await capability_service.disable_capability_by_slug(
            db, workspace_id, capability_slug
        )
    return ok(None)


@router.delete("/{workspace_id}/capabilities/{capability_id}")
async def remove_capability_override(
    workspace_id: str,
    capability_id: str,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    from clawbuddy.services.capability import capability_service

    try:
        await capability_service.remove_capability_override(
            db, workspace_id, capability_id
        )
        return ok(None)
    except Exception:
        return fail("Override not found", status_code=404)


# ── Workspace Container Management ─────────────────────────

@router.get("/{workspace_id}/container/status")
async def get_container_status(workspace_id: str) -> dict[str, Any]:
    from clawbuddy.services.sandbox import sandbox_service

    try:
        container_status = await sandbox_service.get_workspace_container_status(
            workspace_id
        )
    except NoResultFound:
        return fail("Workspace not found", status_code=404)
    return ok(container_status)


@router.post("/{workspace_id}/container/start")
async def start_container(workspace_id: str) -> dict[str, Any]:
    from clawbuddy.services.sandbox import sandbox_service

    try:
        container_id = (
            await sandbox_service.start_workspace_container_with_capabilities(
                workspace_id
            )
        )
    except NoResultFound:
        return fail("Workspace not found", status_code=404)
    return ok({"containerId": container_id, "status": "running"})


@router.post("/{workspace_id}/container/stop")
async def stop_container(workspace_id: str) -> dict[str, Any]:
    from clawbuddy.services.sandbox import sandbox_service

    try:
        await sandbox_service.stop_workspace_container(workspace_id)
    except NoResultFound:
        return fail("Workspace not found", status_code=404)
    return ok({"status": "stopped"})
