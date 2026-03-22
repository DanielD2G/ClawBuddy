"""Workspace service.

Replaces: apps/api/src/services/workspace.service.ts
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from clawbuddy.db.models import Workspace
from clawbuddy.schemas.workspace import merge_workspace_settings


class WorkspaceService:
    """CRUD operations for workspaces."""

    def serialize(self, workspace: Workspace) -> dict[str, Any]:
        """Convert an ORM workspace into the API response shape."""
        return {
            "id": workspace.id,
            "name": workspace.name,
            "description": workspace.description,
            "permissions": workspace.permissions,
            "color": workspace.color,
            "settings": workspace.settings,
            "autoExecute": workspace.auto_execute,
            "containerId": workspace.container_id,
            "containerStatus": workspace.container_status,
            "createdAt": workspace.created_at.isoformat(),
            "updatedAt": workspace.updated_at.isoformat(),
        }

    def serialize_many(self, workspaces: list[Workspace]) -> list[dict[str, Any]]:
        """Convert multiple ORM workspaces into API response shapes."""
        return [self.serialize(workspace) for workspace in workspaces]

    async def list(self, db: AsyncSession) -> list[Workspace]:
        result = await db.execute(
            select(Workspace).order_by(Workspace.created_at.desc())
        )
        return list(result.scalars().all())

    async def create(self, db: AsyncSession, data: dict[str, Any]) -> Workspace:
        workspace = Workspace(
            name=data["name"],
            description=data.get("description"),
            color=data.get("color"),
            settings=data.get("settings"),
        )
        db.add(workspace)
        await db.commit()
        await db.refresh(workspace)
        return workspace

    async def find_by_id(self, db: AsyncSession, workspace_id: str) -> Workspace | None:
        result = await db.execute(
            select(Workspace).where(Workspace.id == workspace_id)
        )
        return result.scalar_one_or_none()

    async def update(
        self, db: AsyncSession, workspace_id: str, data: dict[str, Any]
    ) -> Workspace:
        result = await db.execute(
            select(Workspace).where(Workspace.id == workspace_id)
        )
        workspace = result.scalar_one()

        # Handle settings merge
        if "settings" in data:
            if data["settings"] is None:
                workspace.settings = None
            else:
                merged = merge_workspace_settings(
                    workspace.settings, data["settings"]
                )
                workspace.settings = merged
        if "name" in data and data["name"] is not None:
            workspace.name = data["name"]
        if "description" in data:
            workspace.description = data["description"]
        if "color" in data:
            workspace.color = data["color"]
        if "permissions" in data:
            workspace.permissions = data["permissions"]
        if "autoExecute" in data:
            workspace.auto_execute = data["autoExecute"]

        await db.commit()
        await db.refresh(workspace)
        return workspace

    async def delete(self, db: AsyncSession, workspace_id: str) -> None:
        result = await db.execute(
            select(Workspace).where(Workspace.id == workspace_id)
        )
        workspace = result.scalar_one()
        await db.delete(workspace)
        await db.commit()

    async def get_settings(
        self, db: AsyncSession, workspace_id: str
    ) -> dict[str, Any] | None:
        result = await db.execute(
            select(Workspace.settings).where(Workspace.id == workspace_id)
        )
        settings = result.scalar_one()
        return settings


workspace_service = WorkspaceService()
