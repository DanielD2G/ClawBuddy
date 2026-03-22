"""Channel type definitions.

Replaces: apps/api/src/channels/types.ts
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel


class TelegramChannelConfig(BaseModel):
    """Configuration for a Telegram bot channel."""

    botToken: str
    botUsername: Optional[str] = None


class ChannelConfig(BaseModel):
    """Top-level channel config envelope."""

    telegram: TelegramChannelConfig
