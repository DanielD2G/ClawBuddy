"""Search routes.

Replaces: apps/api/src/routes/search.ts
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from clawbuddy.lib.responses import fail, ok
from clawbuddy.services.embedding import embedding_service
from clawbuddy.services.search import search_service

router = APIRouter(tags=["Search"])


class SearchBody(BaseModel):
    query: str
    workspace_id: str = Field(alias="workspaceId")
    limit: int = 10

    model_config = {"populate_by_name": True}


@router.post("/search")
async def search(body: SearchBody) -> dict[str, Any]:
    if not body.query or not body.workspace_id:
        return fail("query and workspaceId are required", status_code=400)

    query_vector = await embedding_service.embed(body.query)
    results = await search_service.search(
        query_vector,
        limit=body.limit,
        workspace_id=body.workspace_id,
    )
    return ok(results)
