"""Channels router — manage messaging channel integrations.

Replaces: apps/api/src/routes/channels.ts
"""

from __future__ import annotations

from typing import Any

from aiogram import Bot
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from clawbuddy.channels.telegram.bot_manager import telegram_bot_manager
from clawbuddy.db.session import get_db
from clawbuddy.lib.responses import fail, ok
from clawbuddy.services.channel import channel_service

router = APIRouter(tags=["channels"])


@router.get("/")
async def list_channels(
    workspaceId: str | None = None,
    db: AsyncSession = Depends(get_db),
) -> Any:
    """List channels (optionally filtered by workspaceId)."""
    channels = await channel_service.list(db, workspace_id=workspaceId)
    for ch in channels:
        ch["running"] = (
            telegram_bot_manager.is_running(ch["id"])
            if ch["type"] == "telegram"
            else False
        )
    return ok(channels)


# test-token must come before /{channel_id} to avoid path param capture
@router.post("/test-token")
async def test_token(body: dict[str, Any]) -> Any:
    """Test a bot token without creating a channel first (for onboarding)."""
    bot_token = body.get("botToken")
    if not bot_token:
        return fail("botToken is required")
    try:
        bot = Bot(token=bot_token)
        try:
            me = await bot.get_me()
            return ok(
                {
                    "username": me.username,
                    "firstName": me.first_name,
                }
            )
        finally:
            await bot.session.close()
    except Exception as exc:
        return fail(str(exc) if str(exc) else "Invalid bot token")


@router.get("/{channel_id}")
async def get_channel(
    channel_id: str,
    db: AsyncSession = Depends(get_db),
) -> Any:
    """Get a single channel."""
    # Try by workspace+type first, then by ID
    channel_obj = await channel_service.get_by_workspace_and_type(
        db, channel_id, "telegram"
    )
    if not channel_obj:
        channels = await channel_service.list(db)
        match = next((c for c in channels if c["id"] == channel_id), None)
        if not match:
            return fail("Channel not found", status_code=404)
        match["running"] = (
            telegram_bot_manager.is_running(match["id"])
            if match["type"] == "telegram"
            else False
        )
        return ok(match)

    channels = await channel_service.list(db)
    ch_data = next((c for c in channels if c["id"] == channel_obj.id), None)
    if ch_data:
        ch_data["running"] = (
            telegram_bot_manager.is_running(ch_data["id"])
            if ch_data["type"] == "telegram"
            else False
        )
        return ok(ch_data)

    return fail("Channel not found", status_code=404)


@router.post("/", status_code=201)
async def create_channel(
    body: dict[str, Any],
    db: AsyncSession = Depends(get_db),
) -> Any:
    """Create a channel."""
    workspace_id = body.get("workspaceId")
    channel_type = body.get("type")
    name = body.get("name")
    config = body.get("config", {})

    if not workspace_id or not channel_type or not name or not config.get("botToken"):
        return fail("workspaceId, type, name, and config.botToken are required")

    channel = await channel_service.create(
        db,
        workspace_id=workspace_id,
        channel_type=channel_type,
        name=name,
        config=config,
    )
    return ok(
        {
            "id": channel.id,
            "workspaceId": channel.workspace_id,
            "type": channel.type,
            "name": channel.name,
            "enabled": channel.enabled,
        },
        status_code=201,
    )


@router.patch("/{channel_id}")
async def update_channel(
    channel_id: str,
    body: dict[str, Any],
    db: AsyncSession = Depends(get_db),
) -> Any:
    """Update a channel."""
    channel = await channel_service.update(db, channel_id, data=body)
    return ok(
        {
            "id": channel.id,
            "workspaceId": channel.workspace_id,
            "type": channel.type,
            "name": channel.name,
            "enabled": channel.enabled,
        }
    )


@router.delete("/{channel_id}")
async def delete_channel(
    channel_id: str,
    db: AsyncSession = Depends(get_db),
) -> Any:
    """Delete a channel and stop its bot."""
    await telegram_bot_manager.stop_bot(channel_id)
    await channel_service.delete(db, channel_id)
    return ok(None)


@router.post("/{channel_id}/enable")
async def enable_channel(
    channel_id: str,
    db: AsyncSession = Depends(get_db),
) -> Any:
    """Enable a channel and start its bot."""
    channel_data = await channel_service.get(db, channel_id)
    config = channel_service.get_decrypted_config(channel_data)

    if channel_data.type == "telegram":
        bot_username = await telegram_bot_manager.start_bot(
            channel_id, config["botToken"], channel_data.workspace_id
        )
        # Store the bot username in config
        await channel_service.update(
            db, channel_id, data={"config": {"botUsername": bot_username}}
        )

    await channel_service.enable(db, channel_id)
    return ok(None)


@router.post("/{channel_id}/disable")
async def disable_channel(
    channel_id: str,
    db: AsyncSession = Depends(get_db),
) -> Any:
    """Disable a channel and stop its bot."""
    await telegram_bot_manager.stop_bot(channel_id)
    await channel_service.disable(db, channel_id)
    return ok(None)


@router.post("/{channel_id}/test")
async def test_channel(
    channel_id: str,
    db: AsyncSession = Depends(get_db),
) -> Any:
    """Test a channel's bot token connectivity."""
    try:
        channel_data = await channel_service.get(db, channel_id)
        config = channel_service.get_decrypted_config(channel_data)
        bot = Bot(token=config["botToken"])
        try:
            me = await bot.get_me()
            return ok(
                {
                    "username": me.username,
                    "firstName": me.first_name,
                    "canJoinGroups": me.can_join_groups,
                    "canReadAllGroupMessages": me.can_read_all_group_messages,
                }
            )
        finally:
            await bot.session.close()
    except Exception as exc:
        return fail(str(exc) if str(exc) else "Failed to connect to Telegram")
