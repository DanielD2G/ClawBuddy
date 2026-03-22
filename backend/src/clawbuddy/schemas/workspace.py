"""Workspace schemas.

Replaces: packages/shared/src/schemas/workspace.schema.ts
         + packages/shared/src/types/workspace-settings.ts
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


# ── Workspace Settings ───────────────────────────────────────

DEFAULT_SECRET_REDACTION_ENABLED: bool = True


class WorkspaceSettings(BaseModel):
    """Workspace-level settings stored as JSON."""

    secret_redaction_enabled: bool = Field(
        default=DEFAULT_SECRET_REDACTION_ENABLED,
        alias="secretRedactionEnabled",
    )

    model_config = {"extra": "allow", "populate_by_name": True}


def parse_workspace_settings(value: Any) -> WorkspaceSettings | None:
    """Parse an arbitrary value into WorkspaceSettings, or None if invalid."""
    if not value or not isinstance(value, dict):
        return None
    try:
        return WorkspaceSettings.model_validate(value)
    except Exception:
        return None


def is_secret_redaction_enabled(settings: Any) -> bool:
    """Check if secret redaction is enabled for the workspace."""
    parsed = parse_workspace_settings(settings)
    if parsed is None:
        return DEFAULT_SECRET_REDACTION_ENABLED
    return parsed.secret_redaction_enabled


def merge_workspace_settings(
    existing: Any,
    updates: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Merge existing workspace settings with updates.

    Returns None if updates is explicitly None (clearing settings).
    """
    if updates is None:
        return None

    existing_parsed = parse_workspace_settings(existing)
    base = existing_parsed.model_dump(by_alias=True) if existing_parsed else {}

    if not isinstance(updates, dict):
        return base or None

    base.update(updates)
    return base


# ── Workspace Permissions ────────────────────────────────────

class WorkspacePermissions(BaseModel):
    """Workspace permissions configuration."""

    allow: list[str] = Field(default_factory=list)


# ── CRUD Schemas ─────────────────────────────────────────────

class CreateWorkspaceInput(BaseModel):
    """Create workspace request body."""

    name: str = Field(min_length=1, max_length=100, description="Workspace name is required")
    description: str | None = Field(default=None, max_length=500)
    color: str | None = Field(default=None, max_length=20)
    settings: dict[str, Any] | None = None


class UpdateWorkspaceInput(BaseModel):
    """Update workspace request body."""

    name: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=500)
    color: str | None = Field(default=None, max_length=20)
    permissions: WorkspacePermissions | None = None
    settings: dict[str, Any] | None = None
    auto_execute: bool | None = Field(default=None, alias="autoExecute")

    model_config = {"populate_by_name": True}
