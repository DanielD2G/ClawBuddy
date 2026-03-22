"""Agent debug logging — per-session logger with secret redaction.

Replaces: apps/api/src/services/agent-debug.service.ts
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol

from loguru import logger

from clawbuddy.services.secret_redaction import SecretInventory, secret_redaction_service

DEBUG = os.getenv("DEBUG_AGENT") == "1" or os.getenv("DEBUG") == "1"
DEBUG_LOG_DIR = Path.cwd() / "logs" / "agent"
_log_dir_ready = False


def _ensure_log_dir() -> None:
    global _log_dir_ready
    if _log_dir_ready:
        return
    try:
        DEBUG_LOG_DIR.mkdir(parents=True, exist_ok=True)
        _log_dir_ready = True
    except Exception:
        pass


class SessionLogger(Protocol):
    def debug_log(self, label: str, data: Any = ...) -> None: ...
    def log_llm_request(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]], iteration: int
    ) -> None: ...
    def log_llm_response(
        self, response: dict[str, Any], duration_ms: int, iteration: int
    ) -> None: ...
    def log_tool_result(
        self, tool_name: str, result: dict[str, Any]
    ) -> None: ...


class _SessionLoggerImpl:
    """Per-session debug logger with secret redaction."""

    def __init__(self, session_id: str, inventory: SecretInventory) -> None:
        self._inventory = inventory
        self._log_file: Path | None = None
        if DEBUG:
            _ensure_log_dir()
            date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            self._log_file = DEBUG_LOG_DIR / f"{date_str}_{session_id}.log"
        self.debug_log("═══ Session log initialized ═══")

    def _redact(self, value: Any) -> Any:
        return secret_redaction_service.redact_for_public_storage(value, self._inventory)

    def _write_line(self, line: str) -> None:
        logger.debug(line)
        if self._log_file:
            try:
                with open(self._log_file, "a", encoding="utf-8") as f:
                    f.write(line + "\n")
            except Exception:
                pass

    def _write_block(self, lines: list[str]) -> None:
        if self._log_file:
            try:
                with open(self._log_file, "a", encoding="utf-8") as f:
                    f.write("\n".join(lines) + "\n")
            except Exception:
                pass

    def debug_log(self, label: str, data: Any = ...) -> None:
        if not DEBUG:
            return
        ts = datetime.now(timezone.utc).strftime("%H:%M:%S.%f")[:12]
        if data is not ...:
            safe_data = self._redact(data)
            data_str = (
                safe_data
                if isinstance(safe_data, str)
                else json.dumps(safe_data, indent=2, default=str)
            )
            self._write_line(f"[Agent {ts}] {label} {data_str}")
        else:
            self._write_line(f"[Agent {ts}] {label}")

    def log_llm_request(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        iteration: int,
    ) -> None:
        if not DEBUG or not self._log_file:
            return
        safe_messages = self._redact(messages)
        safe_tools = self._redact(tools)
        sep = f"\n{'─' * 80}\n"

        # Get text content from first message
        first_content = ""
        if safe_messages:
            c = safe_messages[0].get("content", "")
            first_content = c if isinstance(c, str) else json.dumps(c, default=str)

        tool_summary = "\n".join(
            f"  - {t.get('name', '?')}: {str(t.get('description', ''))[:120]}"
            for t in safe_tools
        )

        msg_lines: list[str] = []
        for m in safe_messages[-5:]:
            content = m.get("content", "")
            if not isinstance(content, str):
                content = json.dumps(content, default=str)
            preview = content[:1000]
            suffix = f"... ({len(content)} chars)" if len(content) > 1000 else ""
            tool_call_id = m.get("toolCallId", "")
            role = m.get("role", "?")
            tc_info = f" toolCallId={tool_call_id}" if tool_call_id else ""

            tc_summary = ""
            for tc in m.get("toolCalls", []) or []:
                args_str = json.dumps(tc.get("arguments", {}), default=str)[:200]
                tc_summary += f"\n    [tool_call: {tc.get('name', '?')}({args_str})]"

            msg_lines.append(f"  [{role}{tc_info}] {preview}{suffix}{tc_summary}")

        self._write_block([
            sep,
            f">>> LLM REQUEST (iteration {iteration})",
            f">>> {len(safe_messages)} messages, {len(safe_tools)} tools",
            sep,
            ">>> SYSTEM PROMPT:",
            first_content[:5000],
            sep,
            ">>> TOOLS:",
            tool_summary,
            sep,
            ">>> MESSAGES (last 5):",
            *msg_lines,
            sep,
        ])

    def log_llm_response(
        self,
        response: dict[str, Any],
        duration_ms: int,
        iteration: int,
    ) -> None:
        if not DEBUG or not self._log_file:
            return
        safe = self._redact(response)
        sep = f"\n{'─' * 80}\n"

        usage = safe.get("usage")
        usage_str = (
            f"in={usage.get('inputTokens', 0)} "
            f"out={usage.get('outputTokens', 0)} "
            f"total={usage.get('totalTokens', 0)}"
            if usage
            else "n/a"
        )

        lines = [
            sep,
            f"<<< LLM RESPONSE (iteration {iteration}, {duration_ms}ms)",
            f"<<< finishReason: {safe.get('finishReason', '?')}",
            f"<<< usage: {usage_str}",
            sep,
            "<<< CONTENT:",
            safe.get("content") or "(empty)",
        ]

        tool_calls = safe.get("toolCalls") or []
        if tool_calls:
            lines.append(sep)
            lines.append("<<< TOOL CALLS:")
            for tc in tool_calls:
                lines.append(
                    f"  - {tc.get('name', '?')}({json.dumps(tc.get('arguments', {}), indent=2, default=str)})"
                )

        lines.append(sep)
        self._write_block(lines)

    def log_tool_result(
        self,
        tool_name: str,
        result: dict[str, Any],
    ) -> None:
        if not DEBUG or not self._log_file:
            return
        safe = self._redact(result)
        output = safe.get("output", "")
        output_preview = output[:2000] if output else ""
        truncated = f"\n  │ ... (truncated)" if output and len(output) > 2000 else ""

        lines = [
            f"  ┌── TOOL RESULT: {tool_name} ({safe.get('durationMs', 0)}ms, exit={safe.get('exitCode', 'n/a')})",
        ]
        if safe.get("error"):
            lines.append(f"  │ ERROR: {safe['error']}")
        lines.extend([
            f"  │ OUTPUT ({len(output)} chars):",
            f"  │ {output_preview}{truncated}",
            "  └──",
        ])
        self._write_block(lines)


def create_session_logger(
    session_id: str, inventory: SecretInventory
) -> _SessionLoggerImpl:
    """Create a per-session debug logger."""
    return _SessionLoggerImpl(session_id, inventory)
