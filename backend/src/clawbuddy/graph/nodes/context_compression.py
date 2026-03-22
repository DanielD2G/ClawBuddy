"""Context compression node — compresses conversation context when it grows too large.

Replaces: Context compression invocation in agent.service.ts
"""

from __future__ import annotations

from typing import Any

from loguru import logger
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from clawbuddy.db.models import ChatMessage, ChatSession
from clawbuddy.graph.state import AgentGraphState
from clawbuddy.services.context_compression import compress_context
from clawbuddy.services.settings_service import settings_service


async def run_context_compression(state: AgentGraphState) -> dict[str, Any]:
    """Run context compression if needed. Updates session DB with summary.

    Returns dict with 'summary', 'recent_messages', and 'compressed'.
    """
    db: AsyncSession = state.db

    # Load conversation history
    result = await db.execute(
        select(ChatMessage)
        .where(ChatMessage.session_id == state.session_id)
        .order_by(ChatMessage.created_at.asc())
    )
    history_records = result.scalars().all()

    history = [
        {
            "id": m.id,
            "role": m.role,
            "content": m.content or "",
            "toolCalls": m.tool_calls,
            "createdAt": m.created_at,
        }
        for m in history_records
    ]

    # Get session data for existing summary
    session_result = await db.execute(
        select(ChatSession).where(ChatSession.id == state.session_id)
    )
    session = session_result.scalar_one_or_none()
    if not session:
        return {
            "summary": None,
            "recent_messages": history,
            "compressed": False,
        }

    context_limit = await settings_service.get_context_limit_tokens()

    if state.emit:
        await state.emit("compressing", {"status": "start"})

    compressed = await compress_context(
        history=history,
        existing_summary=session.context_summary,
        existing_summary_up_to=session.context_summary_up_to,
        last_input_tokens=session.last_input_tokens,
        session_id=state.session_id,
        max_context_tokens=context_limit,
    )

    if compressed.compressed and compressed.last_summarized_message_id:
        session.context_summary = compressed.summary
        session.context_summary_up_to = compressed.last_summarized_message_id
        await db.flush()

        summarized_count = len(history) - len(compressed.recent_messages)
        if state.emit:
            await state.emit("compressing", {
                "status": "done",
                "summarizedCount": summarized_count,
                "keptCount": len(compressed.recent_messages),
            })
        logger.info(
            f"[Context] Compressed {summarized_count} messages, "
            f"keeping {len(compressed.recent_messages)} recent"
        )
    else:
        if state.emit:
            await state.emit("compressing", {"status": "skipped"})

    return {
        "summary": compressed.summary,
        "recent_messages": compressed.recent_messages,
        "compressed": compressed.compressed,
    }
