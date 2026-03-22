"""Stats routes.

Replaces: apps/api/src/routes/stats.ts
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from clawbuddy.db.models import ChatSession, Document, Workspace
from clawbuddy.db.session import get_db
from clawbuddy.lib.responses import ok

router = APIRouter(tags=["Stats"])


@router.get("/stats")
async def get_stats(db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    ws_count = await db.scalar(select(func.count()).select_from(Workspace))
    doc_count = await db.scalar(select(func.count()).select_from(Document))
    session_count = await db.scalar(select(func.count()).select_from(ChatSession))

    return ok(
        {
            "workspaces": ws_count or 0,
            "documents": doc_count or 0,
            "chatSessions": session_count or 0,
        }
    )
