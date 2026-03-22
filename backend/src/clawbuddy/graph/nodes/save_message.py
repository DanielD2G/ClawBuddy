"""Save message node — persists chat messages and agent state to DB.

Replaces: Message saving logic from agent.service.ts
"""

from __future__ import annotations

from typing import Any

from loguru import logger
from sqlalchemy.ext.asyncio import AsyncSession

from clawbuddy.db.models import ChatMessage, ChatSession
from clawbuddy.graph.state import AgentGraphState
from clawbuddy.lib.sanitize import strip_null_bytes
from clawbuddy.services.agent_state import (
    AgentState,
    build_public_agent_state,
    serialize_encrypted_agent_state,
)


async def save_user_message(
    db: AsyncSession,
    session_id: str,
    content: str,
    *,
    attachments: list[dict[str, Any]] | None = None,
) -> str:
    """Save a user message to the database. Returns the message ID."""
    msg = ChatMessage(
        session_id=session_id,
        role="user",
        content=strip_null_bytes(content),
    )
    if attachments:
        msg.attachments = attachments
    db.add(msg)
    await db.flush()
    return msg.id


async def save_assistant_message(
    state: AgentGraphState,
    content: str,
    *,
    sources: list[dict[str, Any]] | None = None,
    tool_calls: list[dict[str, Any]] | None = None,
) -> str | None:
    """Save an assistant message to the database. Returns the message ID."""
    if not content.strip():
        return None

    db: AsyncSession = state.db
    try:
        data: dict[str, Any] = {
            "session_id": state.session_id,
            "role": "assistant",
            "content": strip_null_bytes(content),
        }
        if sources:
            data["sources"] = sources
        if tool_calls:
            data["tool_calls"] = tool_calls

        msg = ChatMessage(**data)
        db.add(msg)
        await db.flush()

        state.last_message_id = msg.id
        logger.debug(f"[Agent] Saved assistant message: {msg.id}")
        return msg.id
    except Exception as e:
        logger.error(f"[Agent] Failed to save assistant message: {e}")
        return None


async def save_agent_state_for_approval(
    state: AgentGraphState,
    pending_tool_calls: list[dict[str, Any]],
    iteration: int,
) -> None:
    """Save encrypted agent state for later resume after approval."""
    db: AsyncSession = state.db
    from sqlalchemy import select

    result = await db.execute(
        select(ChatSession).where(ChatSession.id == state.session_id)
    )
    session = result.scalar_one_or_none()
    if not session:
        return

    agent_state = AgentState(
        messages=[],  # Messages are in DB, not serialized
        iteration=iteration,
        pending_tool_calls=pending_tool_calls,
        completed_tool_results=[
            {"toolCallId": r.tool_call_id, "content": r.content}
            for r in state.completed_results
        ],
        tool_execution_log=[
            {
                "toolName": te.tool_name,
                "capabilitySlug": te.capability_slug,
                "input": te.input,
                "output": te.output,
                "error": te.error,
                "exitCode": te.exit_code,
                "durationMs": te.duration_ms,
            }
            for te in state.tool_executions
        ],
        workspace_id=state.workspace_id,
        session_id=state.session_id,
        discovered_capability_slugs=state.discovered_capability_slugs or None,
        mentioned_slugs=state.mentioned_slugs or None,
    )

    inventory = state.secret_inventory
    if inventory:
        public_state = build_public_agent_state(agent_state, inventory)
    else:
        public_state = {"iteration": iteration}

    session.agent_state = public_state
    session.agent_state_encrypted = serialize_encrypted_agent_state(agent_state)
    session.agent_status = "awaiting_approval"

    await db.flush()

    if state.emit:
        await state.emit("awaiting_approval", {
            "agentState": public_state,
        })
