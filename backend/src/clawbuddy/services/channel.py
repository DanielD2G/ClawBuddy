"""Channel service.

Replaces: apps/api/src/services/channel.service.ts
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from clawbuddy.db.models import Channel
from clawbuddy.services.crypto import decrypt, encrypt


def _mask_token(token: str) -> str:
    if len(token) <= 8:
        return "••••••••"
    return token[:4] + "••••" + token[-4:]


class ChannelService:
    """CRUD operations for messaging channels (Telegram, etc.)."""

    async def create(
        self,
        db: AsyncSession,
        *,
        workspace_id: str,
        channel_type: str,
        name: str,
        config: dict[str, Any],
    ) -> Channel:
        encrypted_config = dict(config)
        if config.get("botToken"):
            encrypted_config["botToken"] = encrypt(config["botToken"])

        channel = Channel(
            workspace_id=workspace_id,
            type=channel_type,
            name=name,
            config=encrypted_config,
        )
        db.add(channel)
        await db.commit()
        await db.refresh(channel)
        return channel

    async def update(
        self,
        db: AsyncSession,
        channel_id: str,
        data: dict[str, Any],
    ) -> Channel:
        result = await db.execute(select(Channel).where(Channel.id == channel_id))
        channel = result.scalar_one()
        current_config = dict(channel.config or {})

        config_updates = data.get("config")
        if config_updates:
            if config_updates.get("botToken"):
                current_config["botToken"] = encrypt(config_updates["botToken"])
            if "botUsername" in config_updates:
                current_config["botUsername"] = config_updates["botUsername"]

        channel.config = current_config
        if data.get("name"):
            channel.name = data["name"]

        await db.commit()
        await db.refresh(channel)
        return channel

    async def get(self, db: AsyncSession, channel_id: str) -> Channel:
        """Get a channel by ID (raw ORM object, config still encrypted)."""
        result = await db.execute(select(Channel).where(Channel.id == channel_id))
        return result.scalar_one()

    def get_decrypted_config(self, channel: Channel) -> dict[str, Any]:
        """Return channel config with botToken decrypted."""
        config: dict[str, Any] = dict(channel.config) if channel.config else {}
        if config.get("botToken"):
            config["botToken"] = decrypt(config["botToken"])
        return config

    async def get_by_workspace_and_type(
        self, db: AsyncSession, workspace_id: str, channel_type: str
    ) -> Channel | None:
        result = await db.execute(
            select(Channel).where(
                Channel.workspace_id == workspace_id,
                Channel.type == channel_type,
            )
        )
        return result.scalar_one_or_none()

    async def list(
        self, db: AsyncSession, workspace_id: str | None = None
    ) -> list[dict[str, Any]]:
        stmt = select(Channel)
        if workspace_id:
            stmt = stmt.where(Channel.workspace_id == workspace_id)
        stmt = stmt.order_by(Channel.created_at.desc())
        result = await db.execute(stmt)
        channels = result.scalars().all()

        out: list[dict[str, Any]] = []
        for ch in channels:
            config = dict(ch.config or {})
            if config.get("botToken"):
                try:
                    config["botToken"] = _mask_token(decrypt(config["botToken"]))
                except Exception:
                    config["botToken"] = "••••••••"
            out.append(
                {
                    "id": ch.id,
                    "workspaceId": ch.workspace_id,
                    "type": ch.type,
                    "name": ch.name,
                    "enabled": ch.enabled,
                    "config": config,
                    "createdAt": ch.created_at,
                    "updatedAt": ch.updated_at,
                }
            )
        return out

    async def delete(self, db: AsyncSession, channel_id: str) -> None:
        result = await db.execute(select(Channel).where(Channel.id == channel_id))
        channel = result.scalar_one()
        await db.delete(channel)
        await db.commit()

    async def enable(self, db: AsyncSession, channel_id: str) -> Channel:
        result = await db.execute(select(Channel).where(Channel.id == channel_id))
        channel = result.scalar_one()
        channel.enabled = True
        await db.commit()
        await db.refresh(channel)
        return channel

    async def disable(self, db: AsyncSession, channel_id: str) -> Channel:
        result = await db.execute(select(Channel).where(Channel.id == channel_id))
        channel = result.scalar_one()
        channel.enabled = False
        await db.commit()
        await db.refresh(channel)
        return channel

    async def get_all_enabled(self, db: AsyncSession) -> list[Channel]:
        result = await db.execute(
            select(Channel).where(Channel.enabled == True)
        )
        return list(result.scalars().all())


channel_service = ChannelService()
