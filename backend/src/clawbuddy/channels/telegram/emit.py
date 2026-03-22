"""Telegram emit adapter — forwards SSE 'content' events to Telegram chats.

Replaces: apps/api/src/channels/telegram/telegram-emit.ts

Creates a callable matching the SSEEmit protocol that forwards content
events to Telegram via the bot manager. Failures are logged but never
propagated to the caller (fire-and-forget semantics).
"""

from __future__ import annotations

import asyncio
from typing import Any, Callable, Coroutine

from loguru import logger


def create_telegram_emit(
    workspace_id: str,
    chat_id: str,
) -> Callable[..., Coroutine[Any, Any, None]]:
    """Create an SSE emit function that forwards 'content' events to Telegram.

    Returns an async callable ``(event, data) -> None``.
    """

    async def telegram_emit(event: str, data: dict[str, Any]) -> None:
        if event == "content" and isinstance(data.get("text"), str) and data["text"].strip():
            try:
                from clawbuddy.channels.telegram.bot_manager import telegram_bot_manager

                await telegram_bot_manager.send_to_chat(
                    workspace_id, chat_id, data["text"]
                )
            except Exception as exc:
                logger.error(
                    f"[Telegram] Failed to forward cron content to Telegram: {exc}"
                )

    return telegram_emit
