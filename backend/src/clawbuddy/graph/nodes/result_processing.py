"""Result processing node — truncates outputs, extracts screenshots, prunes old results.

Replaces: agent-tool-results.service.ts logic
"""

from __future__ import annotations

import json
from typing import Any

from clawbuddy.lib.screenshot import extract_screenshot_base64


def maybe_truncate_output(output: str, *, max_chars: int = 50_000) -> str:
    """Truncate tool output if it exceeds max_chars, keeping start and end."""
    if len(output) <= max_chars:
        return output
    half = max_chars // 2
    return (
        output[:half]
        + f"\n\n... [output truncated — {len(output)} chars total] ...\n\n"
        + output[-half:]
    )


def build_tool_result_content(
    output: str,
    *,
    error: str | None = None,
    exit_code: int | None = None,
) -> str:
    """Build the content string for a tool result message."""
    result = maybe_truncate_output(output)

    if error and not output:
        result = f"Error: {error}"

    return result


def prepare_tool_result_for_sse(
    output: str,
    *,
    tool_name: str = "",
    max_preview: int = 2000,
) -> dict[str, str | None]:
    """Prepare tool output for SSE streaming (truncated preview)."""
    if not output:
        return {"output": "", "screenshot": None}

    # For browser scripts, strip screenshot data from SSE
    if tool_name == "run_browser_script":
        try:
            parsed = json.loads(output)
            if isinstance(parsed, dict) and "screenshot" in parsed:
                preview = {k: v for k, v in parsed.items() if k != "screenshot"}
                return {
                    "output": json.dumps(preview)[:max_preview],
                    "screenshot": parsed.get("screenshot"),
                }
        except (json.JSONDecodeError, TypeError):
            pass

    return {"output": output[:max_preview], "screenshot": None}


def extract_screenshot_from_output(output: str) -> tuple[str | None, str]:
    """Extract screenshot base64 from browser tool output.

    Returns (screenshot_b64, cleaned_output).
    """
    extracted = extract_screenshot_base64(output)
    if extracted.screenshot_b64:
        return extracted.screenshot_b64, extracted.description or "Screenshot captured"
    return None, output


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
        (i, m) for i, m in enumerate(messages) if m.get("role") == "tool"
    ]

    to_prune = (
        tool_results[:-keep_recent] if len(tool_results) > keep_recent else []
    )

    for idx, msg in to_prune:
        content = msg.get("content", "")
        if isinstance(content, str) and len(content) > max_chars:
            messages[idx] = {
                **msg,
                "content": content[:max_chars] + "\n... [pruned for context]",
            }
            pruned += 1

    return pruned
