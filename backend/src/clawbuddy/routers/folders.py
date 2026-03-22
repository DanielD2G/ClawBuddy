"""Folder routes.

Replaces: apps/api/src/routes/folders.ts
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from clawbuddy.db.session import get_db
from clawbuddy.lib.responses import fail, ok
from clawbuddy.schemas.folder import CreateFolderInput
from clawbuddy.services.folder import folder_service

router = APIRouter(tags=["Folders"])


@router.get("/workspaces/{workspace_id}/folders")
async def list_folders(
    workspace_id: str,
    parentId: str | None = None,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    parent = None if parentId is None or parentId == "null" else parentId
    folders = await folder_service.list_by_parent(db, workspace_id, parent)
    return ok(folders)


@router.get("/workspaces/{workspace_id}/folders/{folder_id}")
async def get_folder(
    workspace_id: str,
    folder_id: str,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    result = await folder_service.get_with_ancestors(db, folder_id)
    if not result:
        return fail("Folder not found", status_code=404)
    return ok(result)


@router.post("/workspaces/{workspace_id}/folders", status_code=status.HTTP_201_CREATED)
async def create_folder(
    workspace_id: str,
    body: CreateFolderInput,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    folder = await folder_service.create(
        db,
        name=body.name,
        workspace_id=workspace_id,
        parent_id=body.parent_id,
    )
    return ok(folder)


@router.delete("/workspaces/{workspace_id}/folders/{folder_id}")
async def delete_folder(
    workspace_id: str,
    folder_id: str,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    await folder_service.delete(db, folder_id)
    return ok({"id": folder_id})
