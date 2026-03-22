"""Admin router — system stats, workspace/document/conversation management, settings.

Replaces: apps/api/src/routes/admin.ts
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from clawbuddy.db.models import (
    ChatMessage,
    ChatSession,
    Document,
    GlobalSettings,
    Workspace,
)
from clawbuddy.db.session import get_db
from clawbuddy.lib.pagination import parse_pagination
from clawbuddy.lib.responses import fail, ok

router = APIRouter(tags=["admin"])


# ── Stats ────────────────────────────────────────────────────


@router.get("/admin/stats")
async def admin_stats(db: AsyncSession = Depends(get_db)) -> Any:
    """Get system-wide counts."""
    ws_count = (await db.execute(select(func.count(Workspace.id)))).scalar() or 0
    doc_count = (await db.execute(select(func.count(Document.id)))).scalar() or 0
    conv_count = (await db.execute(select(func.count(ChatSession.id)))).scalar() or 0
    return ok(
        {"workspaces": ws_count, "documents": doc_count, "conversations": conv_count}
    )


# ── Workspaces ───────────────────────────────────────────────


@router.get("/admin/workspaces")
async def admin_workspaces(
    page: int | None = None,
    limit: int | None = None,
    search: str = "",
    db: AsyncSession = Depends(get_db),
) -> Any:
    """List workspaces with pagination and optional search."""
    pag = parse_pagination(page, limit)

    query = select(Workspace).order_by(Workspace.created_at.desc())
    count_query = select(func.count(Workspace.id))

    if search:
        query = query.where(Workspace.name.ilike(f"%{search}%"))
        count_query = count_query.where(Workspace.name.ilike(f"%{search}%"))

    query = query.offset(pag["skip"]).limit(pag["limit"])

    result = await db.execute(query)
    workspaces = result.scalars().all()
    total = (await db.execute(count_query)).scalar() or 0

    items = []
    for ws in workspaces:
        doc_count = (
            await db.execute(
                select(func.count(Document.id)).where(
                    Document.workspace_id == ws.id
                )
            )
        ).scalar() or 0
        session_count = (
            await db.execute(
                select(func.count(ChatSession.id)).where(
                    ChatSession.workspace_id == ws.id
                )
            )
        ).scalar() or 0
        items.append(
            {
                "id": ws.id,
                "name": ws.name,
                "description": ws.description,
                "createdAt": ws.created_at.isoformat() if ws.created_at else None,
                "_count": {
                    "documents": doc_count,
                    "chatSessions": session_count,
                },
            }
        )

    return ok(
        {
            "workspaces": items,
            "total": total,
            "page": pag["page"],
            "limit": pag["limit"],
        }
    )


# ── Documents ────────────────────────────────────────────────


@router.get("/admin/documents")
async def admin_documents(
    page: int | None = None,
    limit: int | None = None,
    search: str = "",
    status: str = "",
    db: AsyncSession = Depends(get_db),
) -> Any:
    """List documents with pagination, search, and status filter."""
    pag = parse_pagination(page, limit)

    query = select(Document).order_by(Document.created_at.desc())
    count_query = select(func.count(Document.id))

    if search:
        query = query.where(Document.title.ilike(f"%{search}%"))
        count_query = count_query.where(Document.title.ilike(f"%{search}%"))
    if status:
        query = query.where(Document.status == status)
        count_query = count_query.where(Document.status == status)

    query = query.offset(pag["skip"]).limit(pag["limit"])

    result = await db.execute(query)
    documents = result.scalars().all()
    total = (await db.execute(count_query)).scalar() or 0

    items = []
    for doc in documents:
        # Fetch workspace info
        ws_result = await db.execute(
            select(Workspace.id, Workspace.name).where(
                Workspace.id == doc.workspace_id
            )
        )
        ws_row = ws_result.first()
        items.append(
            {
                "id": doc.id,
                "title": doc.title,
                "status": doc.status,
                "type": doc.type,
                "chunkCount": doc.chunk_count,
                "createdAt": doc.created_at.isoformat() if doc.created_at else None,
                "workspace": (
                    {"id": ws_row[0], "name": ws_row[1]} if ws_row else None
                ),
            }
        )

    return ok(
        {
            "documents": items,
            "total": total,
            "page": pag["page"],
            "limit": pag["limit"],
        }
    )


# ── Conversations ────────────────────────────────────────────


@router.get("/admin/conversations")
async def admin_conversations(
    page: int | None = None,
    limit: int | None = None,
    search: str = "",
    db: AsyncSession = Depends(get_db),
) -> Any:
    """List conversations with pagination and search."""
    pag = parse_pagination(page, limit)

    query = select(ChatSession).order_by(ChatSession.created_at.desc())
    count_query = select(func.count(ChatSession.id))

    if search:
        query = query.where(ChatSession.title.ilike(f"%{search}%"))
        count_query = count_query.where(ChatSession.title.ilike(f"%{search}%"))

    query = query.offset(pag["skip"]).limit(pag["limit"])

    result = await db.execute(query)
    conversations = result.scalars().all()
    total = (await db.execute(count_query)).scalar() or 0

    items = []
    for conv in conversations:
        msg_count = (
            await db.execute(
                select(func.count(ChatMessage.id)).where(
                    ChatMessage.session_id == conv.id
                )
            )
        ).scalar() or 0
        ws_result = await db.execute(
            select(Workspace.id, Workspace.name).where(
                Workspace.id == conv.workspace_id
            )
        )
        ws_row = ws_result.first()
        items.append(
            {
                "id": conv.id,
                "title": conv.title,
                "createdAt": conv.created_at.isoformat() if conv.created_at else None,
                "workspace": (
                    {"id": ws_row[0], "name": ws_row[1]} if ws_row else None
                ),
                "_count": {"messages": msg_count},
            }
        )

    return ok(
        {
            "conversations": items,
            "total": total,
            "page": pag["page"],
            "limit": pag["limit"],
        }
    )


# ── Settings ─────────────────────────────────────────────────


@router.get("/admin/settings")
async def admin_get_settings() -> Any:
    """Get admin settings with provider state."""
    from clawbuddy.services.provider_state import build_provider_state
    from clawbuddy.services.settings_service import settings_service

    settings = await settings_service.get()

    return ok(
        {
            "providers": await build_provider_state(),
            "onboardingComplete": settings.get("onboardingComplete"),
        }
    )


@router.patch("/admin/settings")
async def admin_update_settings(body: dict[str, Any]) -> Any:
    """Update admin settings (LLM/embedding provider, model, role providers)."""
    from clawbuddy.services.settings_service import settings_service

    await settings_service.update(
        {
            "aiProvider": body.get("llm"),
            "aiModel": body.get("llmModel"),
            "embeddingProvider": body.get("embedding"),
            "embeddingModel": body.get("embeddingModel"),
            "roleProviders": body.get("roleProviders"),
        }
    )

    settings = await settings_service.get()
    return ok(
        {
            "active": {
                "llm": settings.get("aiProvider"),
                "llmModel": settings.get("aiModel"),
                "roleProviders": await settings_service.get_resolved_role_providers(),
                "embedding": settings.get("embeddingProvider"),
                "embeddingModel": settings.get("embeddingModel"),
            }
        }
    )


# ── Provider connections ─────────────────────────────────────


@router.put("/admin/provider-connections/{provider}")
async def set_provider_connection(
    provider: str,
    body: dict[str, Any],
) -> Any:
    """Set a provider connection (API key or base URL)."""
    from clawbuddy.services.model_discovery import invalidate_model_cache
    from clawbuddy.services.provider_state import build_provider_state
    from clawbuddy.services.settings_service import settings_service

    value = body.get("value")
    if not value or not isinstance(value, str):
        return fail("value is required")

    await settings_service.set_provider_connection(provider, value)
    invalidate_model_cache(provider)

    return ok(
        {
            "connections": await settings_service.get_provider_connections(),
            "providers": await build_provider_state(),
        }
    )


@router.delete("/admin/provider-connections/{provider}")
async def remove_provider_connection(provider: str) -> Any:
    """Remove a provider connection."""
    from clawbuddy.services.model_discovery import invalidate_model_cache
    from clawbuddy.services.provider_state import build_provider_state
    from clawbuddy.services.settings_service import settings_service

    await settings_service.remove_provider_connection(provider)
    invalidate_model_cache(provider)

    return ok(
        {
            "connections": await settings_service.get_provider_connections(),
            "providers": await build_provider_state(),
        }
    )


@router.post("/admin/provider-connections/{provider}/test")
async def test_provider_connection_endpoint(
    provider: str,
    body: dict[str, Any] | None = None,
) -> Any:
    """Test a provider connection."""
    from clawbuddy.services.model_discovery import test_provider_connection
    from clawbuddy.services.settings_service import settings_service

    body = body or {}
    request_value = body.get("value") if isinstance(body.get("value"), str) else None
    configured_value = request_value or await settings_service.get_provider_connection_value(
        provider
    )

    if not configured_value or not configured_value.strip():
        return ok(
            {
                "valid": False,
                "reachable": False,
                "llmModels": [],
                "embeddingModels": [],
                "message": "No connection configured",
            }
        )

    result = await test_provider_connection(provider, configured_value)
    return ok(result)


# ── Permissions (Global Auto-Approve Rules) ──────────────────


@router.get("/admin/permissions")
async def get_permissions(db: AsyncSession = Depends(get_db)) -> Any:
    """Get global auto-approve rules."""
    result = await db.execute(
        select(GlobalSettings).where(GlobalSettings.id == "singleton")
    )
    settings = result.scalar_one_or_none()
    rules = (settings.auto_approve_rules if settings else None) or []
    return ok({"autoApproveRules": rules})


@router.patch("/admin/permissions")
async def update_permissions(
    body: dict[str, Any],
    db: AsyncSession = Depends(get_db),
) -> Any:
    """Update global auto-approve rules."""
    rules = body.get("autoApproveRules")
    if not isinstance(rules, list) or not all(isinstance(r, str) for r in rules):
        return fail("autoApproveRules must be a string array")

    result = await db.execute(
        select(GlobalSettings).where(GlobalSettings.id == "singleton")
    )
    settings = result.scalar_one_or_none()

    if settings:
        settings.auto_approve_rules = rules
    else:
        settings = GlobalSettings(id="singleton", auto_approve_rules=rules)
        db.add(settings)

    await db.commit()
    await db.refresh(settings)

    return ok({"autoApproveRules": settings.auto_approve_rules or []})
