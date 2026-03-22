"""LLM call node — invokes the LLM with messages and tools.

Replaces: LLM invocation logic from agent.service.ts runAgentLoop
"""

from __future__ import annotations

import re
import time
from datetime import datetime, timezone
from typing import Any

from loguru import logger
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from clawbuddy.constants import (
    LARGE_TOOL_ARG_THRESHOLD,
    TOOL_ARG_SIZE_LIMIT,
)
from clawbuddy.db.models import ChatSession, TokenUsage as TokenUsageModel
from clawbuddy.graph.state import AgentGraphState
from clawbuddy.services.agent_debug import create_session_logger
from clawbuddy.services.secret_redaction import secret_redaction_service


# Tools exempt from the argument size guard
_SIZE_GUARD_EXEMPT = frozenset({"generate_file", "save_document", "search_documents"})


def check_tool_arg_size(tool_name: str, arguments: dict[str, Any]) -> str | None:
    """Check if a tool call's arguments exceed the size limit.

    Returns a rejection message if too large, None otherwise.
    """
    if tool_name in _SIZE_GUARD_EXEMPT:
        return None
    command_arg = arguments.get("command") or arguments.get("code") or arguments.get("content")
    if not isinstance(command_arg, str) or len(command_arg) <= TOOL_ARG_SIZE_LIMIT:
        return None

    size_kb = round(len(command_arg) / 1000)
    return (
        f"[BLOCKED] {tool_name} contains {size_kb}KB inline data (limit: 10KB). "
        f"Reference files instead of embedding data:\n"
        f"1. Previous outputs are saved in /workspace/.outputs/ — read from there\n"
        f"2. Write a script that processes the file (e.g. cat /workspace/.outputs/<id>.txt | jq ...)\n"
        f"3. For generate_file, use sourcePath to reference the sandbox file\n\n"
        f"Command was NOT executed. Rewrite to reference files."
    )


def content_overlap_ratio(previous_text: str, new_text: str) -> float:
    """Measure overlap between two texts using 3-gram matching.

    Returns ratio between 0 (no overlap) and 1 (fully overlapping).
    Used to detect when the LLM repeats itself across iterations.
    """
    def normalize(s: str) -> str:
        s = s.lower()
        s = re.sub(r"[^a-záéíóúñü0-9\s]", "", s)
        s = re.sub(r"\s+", " ", s)
        return s.strip()

    prev = normalize(previous_text)
    curr = normalize(new_text)
    if not prev or not curr:
        return 0.0

    ngram_size = 3
    words = curr.split(" ")
    if len(words) < ngram_size:
        return 1.0 if prev in curr else 0.0

    prev_words = prev.split(" ")
    prev_set: set[str] = set()
    for i in range(len(prev_words) - ngram_size + 1):
        prev_set.add(" ".join(prev_words[i : i + ngram_size]))

    total = len(words) - ngram_size + 1
    matches = sum(
        1
        for i in range(total)
        if " ".join(words[i : i + ngram_size]) in prev_set
    )

    return matches / total if total > 0 else 0.0


async def record_token_usage(
    usage: dict[str, int] | None,
    session_id: str,
    provider: str,
    model: str,
    db: AsyncSession,
    *,
    update_session_context: bool = True,
) -> None:
    """Record token usage to DB."""
    if not usage:
        return
    try:
        date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        token_record = TokenUsageModel(
            provider=provider,
            model=model,
            input_tokens=usage.get("inputTokens", 0),
            output_tokens=usage.get("outputTokens", 0),
            total_tokens=usage.get("totalTokens", 0),
            session_id=session_id,
            date=date_str,
        )
        db.add(token_record)

        if update_session_context:
            result = await db.execute(
                select(ChatSession).where(ChatSession.id == session_id)
            )
            session = result.scalar_one_or_none()
            if session:
                session.last_input_tokens = usage.get("inputTokens", 0)

        await db.flush()
    except Exception as e:
        logger.error(f"[Agent] Failed to record token usage: {e}")


def prune_old_tool_results(
    messages: list[dict[str, Any]],
    current_iteration: int,
    *,
    keep_recent: int = 3,
    max_chars: int = 500,
) -> int:
    """Truncate old tool result messages to reduce context size.

    Returns the number of messages pruned.
    """
    if current_iteration < 2:
        return 0

    pruned = 0
    tool_results = [
        (i, m)
        for i, m in enumerate(messages)
        if m.get("role") == "tool"
    ]

    # Keep the most recent `keep_recent` tool results intact
    to_prune = tool_results[:-keep_recent] if len(tool_results) > keep_recent else []

    for idx, msg in to_prune:
        content = msg.get("content", "")
        if isinstance(content, str) and len(content) > max_chars:
            messages[idx] = {
                **msg,
                "content": content[:max_chars] + "\n... [pruned for context]",
            }
            pruned += 1

    return pruned


def maybe_truncate_output(output: str, *, max_chars: int = 50_000) -> str:
    """Truncate tool output if it exceeds max_chars."""
    if len(output) <= max_chars:
        return output
    half = max_chars // 2
    return (
        output[:half]
        + f"\n\n... [output truncated — {len(output)} chars total] ...\n\n"
        + output[-half:]
    )
