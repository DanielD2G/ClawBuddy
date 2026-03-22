"""Folder service.

Replaces: apps/api/src/services/folder.service.ts
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from clawbuddy.db.models import Folder


class FolderService:
    """CRUD operations for folders."""

    async def list_by_parent(
        self,
        db: AsyncSession,
        workspace_id: str,
        parent_id: str | None = None,
    ) -> list[Folder]:
        result = await db.execute(
            select(Folder)
            .where(Folder.workspace_id == workspace_id, Folder.parent_id == parent_id)
            .order_by(Folder.name.asc())
        )
        return list(result.scalars().all())

    async def get_with_ancestors(
        self, db: AsyncSession, folder_id: str
    ) -> dict[str, Any] | None:
        result = await db.execute(select(Folder).where(Folder.id == folder_id))
        folder = result.scalar_one_or_none()
        if not folder:
            return None

        ancestors: list[Folder] = []
        current = folder
        while current.parent_id:
            parent_result = await db.execute(
                select(Folder).where(Folder.id == current.parent_id)
            )
            parent = parent_result.scalar_one_or_none()
            if not parent:
                break
            ancestors.insert(0, parent)
            current = parent

        return {"folder": folder, "ancestors": ancestors}

    async def create(
        self,
        db: AsyncSession,
        name: str,
        workspace_id: str,
        parent_id: str | None = None,
    ) -> Folder:
        folder = Folder(name=name, workspace_id=workspace_id, parent_id=parent_id)
        db.add(folder)
        await db.commit()
        await db.refresh(folder)
        return folder

    async def delete(self, db: AsyncSession, folder_id: str) -> None:
        result = await db.execute(select(Folder).where(Folder.id == folder_id))
        folder = result.scalar_one()
        await db.delete(folder)
        await db.commit()


folder_service = FolderService()
