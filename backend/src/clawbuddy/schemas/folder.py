"""Folder schemas.

Replaces: packages/shared/src/schemas/folder.schema.ts
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class CreateFolderInput(BaseModel):
    """Create folder request body."""

    name: str = Field(min_length=1, max_length=100, description="Folder name is required")
    parent_id: str | None = Field(default=None, alias="parentId")

    model_config = {"populate_by_name": True}
