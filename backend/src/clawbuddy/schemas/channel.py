"""Channel schemas.

Replaces: inline Zod schemas from routes/channels.ts
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class CreateChannelInput(BaseModel):
    """Create a channel."""

    type: str = Field(min_length=1)
    name: str = Field(min_length=1)
    config: dict[str, Any] = Field(default_factory=dict)


class UpdateChannelInput(BaseModel):
    """Update a channel."""

    name: str | None = None
    enabled: bool | None = None
    config: dict[str, Any] | None = None
