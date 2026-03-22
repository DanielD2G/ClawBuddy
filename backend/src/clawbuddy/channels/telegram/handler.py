"""Telegram message handler — session management and agent loop integration.

Replaces: apps/api/src/channels/telegram/telegram-handler.ts

Handles incoming Telegram messages by:
1. Finding or creating a ChatSession linked to the Telegram chat
2. Running the agent loop via chatService with a collector emit
3. Forwarding responses back to Telegram via sendFn
"""

from __future__ import annotations

from typing import Any, Callable, Coroutine

from loguru import logger
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from clawbuddy.db.models import ChatSession
from clawbuddy.db.session import async_session_factory


async def _find_or_create_session(
    db: AsyncSession,
    workspace_id: str,
    telegram_chat_id: str,
) -> ChatSession:
    """Find the most recent active Telegram session for this chat, or create a new one."""
    result = await db.execute(
        select(ChatSession)
        .where(
            ChatSession.workspace_id == workspace_id,
            ChatSession.source == "telegram",
            ChatSession.external_chat_id == telegram_chat_id,
        )
        .order_by(ChatSession.created_at.desc())
        .limit(1)
    )
    existing = result.scalar_one_or_none()

    if existing:
        return existing

    session = ChatSession(
        workspace_id=workspace_id,
        source="telegram",
        external_chat_id=telegram_chat_id,
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)
    return session


async def create_new_session(
    workspace_id: str,
    telegram_chat_id: str,
) -> ChatSession:
    """Create a brand-new session for the /new command."""
    async with async_session_factory() as db:
        session = ChatSession(
            workspace_id=workspace_id,
            source="telegram",
            external_chat_id=telegram_chat_id,
        )
        db.add(session)
        await db.commit()
        await db.refresh(session)
        return session


async def handle_telegram_message(
    workspace_id: str,
    telegram_chat_id: str,
    text: str,
    send_fn: Callable[[str], Coroutine[Any, Any, None]],
) -> None:
    """Handle an incoming Telegram text message.

    1. Find or create a ChatSession
    2. Run the agent loop via chatService.sendMessage with a collector emit
    3. Forward content to Telegram via send_fn
    """
    from clawbuddy.services.chat import chat_service
    from clawbuddy.services.secret_redaction import secret_redaction_service

    async with async_session_factory() as db:
        session = await _find_or_create_session(db, workspace_id, telegram_chat_id)
        inventory = await secret_redaction_service.build_secret_inventory(
            db, workspace_id
        )

        async def telegram_emit(event: str, data: dict[str, Any]) -> None:
            if event == "content" and isinstance(data.get("text"), str) and data["text"].strip():
                try:
                    await send_fn(data["text"])
                except Exception:
                    pass  # fire-and-forget

        redacted_emit = secret_redaction_service.create_redacted_emit(
            telegram_emit, inventory
        )

        await chat_service.send_message(
            session_id=session.id,
            content=text,
            emit=redacted_emit,
            options={"inventory": inventory},
            db=db,
        )
