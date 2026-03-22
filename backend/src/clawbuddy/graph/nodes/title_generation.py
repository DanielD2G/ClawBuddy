"""Title generation node — generates a session title from the first message.

Replaces: Title generation logic from agent.service.ts
"""

from __future__ import annotations

from typing import Any

from loguru import logger
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from clawbuddy.db.models import ChatSession


async def maybe_generate_title(
    db: AsyncSession,
    session_id: str,
    user_content: str,
    emit: Any | None = None,
) -> str | None:
    """Generate a session title if one hasn't been set yet.

    Returns the generated title, or None if a title already exists.
    """
    result = await db.execute(
        select(ChatSession).where(ChatSession.id == session_id)
    )
    session = result.scalar_one_or_none()
    if not session:
        return None

    # Skip if title already exists and is not the default
    if session.title and session.title != "New Chat":
        return None

    try:
        from clawbuddy.providers.llm_factory import create_chat_model
        from langchain_core.messages import HumanMessage, SystemMessage

        llm = await create_chat_model(role="title")

        response = await llm.ainvoke([
            SystemMessage(
                content=(
                    "Generate a short, descriptive title (3-7 words) for this "
                    "conversation based on the user's first message. Output ONLY "
                    "the title, no quotes, no punctuation at the end."
                )
            ),
            HumanMessage(content=user_content[:500]),
        ])

        title = (response.content or "").strip().strip('"').strip("'")
        if not title:
            return None

        # Truncate if too long
        if len(title) > 100:
            title = title[:97] + "..."

        session.title = title
        await db.flush()

        if emit:
            await emit("title_update", {"title": title})

        logger.debug(f"[Agent] Generated title: {title}")
        return title

    except Exception as e:
        logger.error(f"[Agent] Failed to generate title: {e}")
        return None
