"""Capability schemas.

Replaces: inline Zod schemas from routes/capabilities.ts
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class UpdateCapabilityInput(BaseModel):
    """Update a workspace capability."""

    enabled: bool | None = None
    config: dict[str, Any] | None = None


class BulkCapabilityItem(BaseModel):
    """A single capability in a bulk update."""

    slug: str
    enabled: bool
    config: dict[str, Any] | None = None


class BulkUpdateCapabilitiesInput(BaseModel):
    """Bulk update workspace capabilities."""

    capabilities: list[BulkCapabilityItem]
