"""Context compression service — summarizes older messages to reduce context size.

Replaces: apps/api/src/services/context-compression.service.ts
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from loguru import logger

from clawbuddy.constants import (
    COMPRESSION_MAX_TOKENS,
    COMPRESSION_PREVIEW_LEN,
    COMPRESSION_TEMPERATURE,
    DEFAULT_MAX_CONTEXT_TOKENS,
    MIN_MESSAGES_FOR_COMPRESSION,
    RECENT_MESSAGES_TO_KEEP,
    TOKEN_ESTIMATION_DIVISOR,
)


@dataclass
class CompressionResult:
    summary: str | None
    recent_messages: list[dict[str, Any]]
    compressed: bool
    last_summarized_message_id: str | None


def _estimate_tokens(messages: list[dict[str, Any]]) -> int:
    """Rough token estimate based on character count."""
    return sum(
        len(str(m.get("content", ""))) // TOKEN_ESTIMATION_DIVISOR + 1
        for m in messages
    )


def _find_safe_split_index(messages: list[dict[str, Any]], keep_count: int) -> int:
    """Find a split index that doesn't break tool-call groups.

    Keeps at least `keep_count` messages at the end, walking backward
    past any trailing `tool` messages to avoid splitting mid-group.
    """
    split_idx = len(messages) - keep_count
    if split_idx <= 0:
        return 0

    while split_idx > 0:
        if messages[split_idx].get("role") == "tool":
            split_idx -= 1
        else:
            break

    return split_idx


async def compress_context(
    history: list[dict[str, Any]],
    existing_summary: str | None,
    existing_summary_up_to: str | None,
    last_input_tokens: int | None,
    session_id: str | None = None,
    max_context_tokens: int | None = None,
) -> CompressionResult:
    """Compress conversation history by summarizing older messages.

    Returns a CompressionResult with the summary and recent messages to keep.
    """
    limit = max_context_tokens or DEFAULT_MAX_CONTEXT_TOKENS

    # Not enough messages to bother
    if len(history) < MIN_MESSAGES_FOR_COMPRESSION:
        return CompressionResult(
            summary=existing_summary,
            recent_messages=history,
            compressed=False,
            last_summarized_message_id=None,
        )

    estimated_tokens = _estimate_tokens(history)
    over_threshold = (
        estimated_tokens > limit
        or (last_input_tokens is not None and last_input_tokens > limit)
    )

    if not over_threshold:
        return CompressionResult(
            summary=existing_summary,
            recent_messages=history,
            compressed=False,
            last_summarized_message_id=None,
        )

    # Find split point
    split_idx = _find_safe_split_index(history, RECENT_MESSAGES_TO_KEEP)
    if split_idx <= 0 and over_threshold:
        for keep in range(min(len(history) - 2, RECENT_MESSAGES_TO_KEEP), 1, -1):
            split_idx = _find_safe_split_index(history, keep)
            if split_idx > 0:
                break

    if split_idx <= 0:
        return CompressionResult(
            summary=existing_summary,
            recent_messages=history,
            compressed=False,
            last_summarized_message_id=None,
        )

    older_messages = history[:split_idx]
    recent_messages = history[split_idx:]
    last_summarized_id = older_messages[-1].get("id")

    # Check if we already summarized to this point
    if existing_summary_up_to == last_summarized_id and existing_summary:
        return CompressionResult(
            summary=existing_summary,
            recent_messages=recent_messages,
            compressed=False,
            last_summarized_message_id=last_summarized_id,
        )

    # Find only new messages to summarize
    messages_to_summarize = older_messages
    if existing_summary_up_to:
        cursor_idx = next(
            (i for i, m in enumerate(older_messages) if m.get("id") == existing_summary_up_to),
            -1,
        )
        if cursor_idx >= 0:
            messages_to_summarize = older_messages[cursor_idx + 1:]

    if not messages_to_summarize and existing_summary:
        return CompressionResult(
            summary=existing_summary,
            recent_messages=recent_messages,
            compressed=False,
            last_summarized_message_id=last_summarized_id,
        )

    # Build summarization prompt
    formatted = "\n".join(
        f"[{m.get('role', '?')}]: {str(m.get('content', ''))[:COMPRESSION_PREVIEW_LEN]}"
        for m in messages_to_summarize
    )

    summary_prompt_parts = [
        "Create a structured summary of the following conversation messages. Organize into these sections:",
        "",
        "1. **Request & Intent**: The user's explicit goals and what they want to accomplish",
        "2. **Technical Context**: Technologies, frameworks, APIs, and concepts discussed",
        "3. **Files & Code**: Files examined/modified with brief descriptions of changes or findings",
        "4. **Errors & Fixes**: Errors encountered and how they were resolved",
        "5. **Tool Actions**: Tools executed and their key outcomes (omit raw outputs)",
        "6. **User Instructions**: Direct user preferences, corrections, or constraints stated",
        "7. **Current State**: What was being worked on at the end of these messages",
        "8. **Pending**: Any unfinished tasks or next steps mentioned",
        "",
        "Rules:",
        "- Be factual and dense. No filler or hedging.",
        "- Preserve exact file paths, function names, and error messages.",
        "- For code changes, describe WHAT changed and WHY, not the full diff.",
        "- Omit tool outputs that were just informational noise.",
        "- Skip empty sections.",
        "",
    ]

    if existing_summary:
        summary_prompt_parts.append(f"Previous summary to extend:\n{existing_summary}\n")

    summary_prompt_parts.append(f"Messages to summarize:\n{formatted}")
    summary_prompt = "\n".join(summary_prompt_parts)

    try:
        from clawbuddy.providers.llm_factory import create_chat_model

        llm = await create_chat_model(role="compact")

        messages_for_llm = [
            {
                "role": "system",
                "content": (
                    "You are a conversation compactor. Analyze the messages "
                    "chronologically and produce a structured summary. "
                    "Output ONLY the summary sections, no preamble."
                ),
            },
            {"role": "user", "content": summary_prompt},
        ]

        from langchain_core.messages import SystemMessage, HumanMessage

        result = await llm.ainvoke(
            [
                SystemMessage(content=messages_for_llm[0]["content"]),
                HumanMessage(content=messages_for_llm[1]["content"]),
            ],
            temperature=COMPRESSION_TEMPERATURE,
            max_tokens=COMPRESSION_MAX_TOKENS,
        )

        summary = result.content.strip() if result.content else existing_summary

        logger.info(
            f"[Context] Compressed {len(messages_to_summarize)} messages, "
            f"keeping {len(recent_messages)} recent"
        )

        return CompressionResult(
            summary=summary,
            recent_messages=recent_messages,
            compressed=True,
            last_summarized_message_id=last_summarized_id,
        )
    except Exception as e:
        logger.error(f"[Context] Compression failed, using full history: {e}")
        return CompressionResult(
            summary=existing_summary,
            recent_messages=history,
            compressed=False,
            last_summarized_message_id=None,
        )
