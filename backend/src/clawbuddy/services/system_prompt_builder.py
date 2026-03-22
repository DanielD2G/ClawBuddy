"""System prompt builder — constructs the full system prompt for the agent.

Replaces: apps/api/src/services/system-prompt-builder.ts
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Protocol
from zoneinfo import ZoneInfo


class PromptCapability(Protocol):
    name: str
    systemPrompt: str


# ---------------------------------------------------------------------------
# XML helpers
# ---------------------------------------------------------------------------

def _escape_xml_attribute(value: str) -> str:
    return (
        value
        .replace("&", "&amp;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def _format_location(tz_name: str) -> str:
    parts = tz_name.split("/")
    if len(parts) >= 2:
        return ", ".join(parts[1:]).replace("_", " ")
    return tz_name


def build_prompt_section(name: str, content: str) -> str:
    """Wrap *content* in an XML-style section tag."""
    return f"<{name}>\n{content.strip()}\n</{name}>"


def build_capability_blocks(capabilities: list[dict[str, str]]) -> str:
    """Build XML capability blocks from a list of {name, systemPrompt} dicts."""
    blocks: list[str] = []
    for cap in capabilities:
        blocks.append(
            f'<capability name="{_escape_xml_attribute(cap["name"])}">\n'
            f'{cap["systemPrompt"].strip()}\n'
            f"</capability>"
        )
    return "\n\n".join(blocks)


def _build_capabilities_section(capabilities: list[dict[str, str]]) -> str:
    if not capabilities:
        return ""
    return build_prompt_section("capabilities", build_capability_blocks(capabilities))


# ---------------------------------------------------------------------------
# Main builder
# ---------------------------------------------------------------------------

def build_system_prompt(
    capabilities: list[dict[str, str]],
    tz_name: str | None = None,
    now: datetime | None = None,
) -> str:
    """Build the full system prompt with role, context, rules, and capabilities.

    Parameters
    ----------
    capabilities:
        List of dicts with "name" and "systemPrompt" keys.
    tz_name:
        IANA timezone string (e.g. "America/New_York"). Defaults to UTC.
    now:
        Override the current time for testing.
    """
    if tz_name is None:
        tz_name = "UTC"
    if now is None:
        now = datetime.now(timezone.utc)

    try:
        tz = ZoneInfo(tz_name)
    except Exception:
        tz = ZoneInfo("UTC")
        tz_name = "UTC"

    local_now = now.astimezone(tz)

    # Format date like "Friday, March 14, 2026"
    date_str = local_now.strftime("%A, %B %d, %Y").replace(" 0", " ")
    # Format time like "10:30 AM"
    time_str = local_now.strftime("%I:%M %p").lstrip("0")
    location = _format_location(tz_name)

    sections: list[str] = [
        build_prompt_section(
            "role",
            "You are a reliable AI assistant with access to tools.\n"
            "Prefer the shortest correct plan that fully solves the user's request. "
            "Use tools efficiently — batch independent calls together rather than "
            "making them one at a time.",
        ),
        build_prompt_section(
            "runtime_context",
            f"Current date: {date_str}\n"
            f"Current time: {time_str} ({tz_name})\n"
            f"User locale hint: {location}\n"
            "Use this context for date-relative questions and locale-sensitive answers.",
        ),
        build_prompt_section(
            "instruction_priority",
            "1. Follow the core operating rules in this prompt.\n"
            "2. Follow the instructions for any currently loaded capability.\n"
            "3. Follow the user's request.\n"
            "If two instructions conflict, follow the higher-priority rule. "
            "Capability instructions refine tool usage, but they do not override "
            "core safety or sandbox constraints unless they explicitly say so.",
        ),
        build_prompt_section(
            "decision_flow",
            "1. If you can answer reliably without tools, answer directly.\n"
            "2. If the task is about uploaded workspace documents or indexed knowledge, "
            "use search_documents. That knowledge base is separate from sandbox files "
            "created during the conversation.\n"
            "3. If tools are needed, choose the most specific suitable tool. Prefer "
            "specialized tools over generic shell or Python workarounds. In particular, "
            "use read_file instead of cat/head/tail via bash to read file contents.\n"
            "4. **Batch independent tool calls in a single response.** When you need "
            "multiple lookups, searches, fetches, or delegations that do not depend on "
            "each other's results, call them ALL in the same assistant turn. This runs "
            "them concurrently and is significantly faster.\n"
            "   - Example: 3 web searches → 3 web_search calls in one message, NOT 3 "
            "sequential turns.\n"
            "   - Example: research + browse → delegate_task(explore, \"search...\") + "
            "delegate_task(explore, \"browse...\") in one message.\n"
            "   - Only chain sequentially when a later call needs an earlier call's output.\n"
            "5. After each tool result, either continue with the next required step or "
            "answer the user. Stop calling tools once you have enough information.",
        ),
        build_prompt_section(
            "user_visibility",
            "Before any non-search tool call, send one brief sentence explaining what "
            "you are about to do and why.\n"
            "For greetings, casual conversation, or simple answers that do not need "
            "tools, respond naturally without calling tools.",
        ),
        build_prompt_section(
            "tool_execution",
            "All tool calls share the same sandbox state, so you can chain them when "
            "later steps depend on earlier outputs.\n"
            "When a task benefits from filtering, formatting, or aggregation, "
            "post-process tool outputs instead of returning raw output.\n"
            "If a tool output is truncated in the UI, continue from the saved file "
            "in /workspace/.outputs/ instead of rerunning the same command.",
        ),
        build_prompt_section(
            "tool_efficiency",
            "The following tools are safe to call in parallel (no shared state): "
            "web_search, web_fetch, search_documents, discover_tools, list_crons, "
            "delegate_task.\n"
            "For these tools, always batch independent calls into a single response. "
            "Sequential calls waste time when the results are independent.\n"
            "For state-modifying tools (run_bash, run_python, generate_file), call "
            "them sequentially when they share files or depend on each other's side "
            "effects.",
        ),
        build_prompt_section(
            "data_constraints",
            "To read file contents, always prefer the read_file tool over bash commands "
            "like cat, head, or tail. read_file provides line numbers, pagination "
            "(offset/limit), binary detection, and automatic size guards.\n"
            "Use read_file for reading source code, config files, logs, and any text "
            "file. For very large files, use the offset and limit parameters to read "
            "specific sections.\n"
            "Only fall back to bash for file reading when you need advanced processing "
            "(jq, grep, awk) that read_file does not support.\n"
            "Commands with more than 5KB of inline data are rejected. Never paste large "
            "previous outputs into new commands; read from files instead.\n"
            "For generate_file, prefer sourcePath when the content already exists in "
            "the sandbox.",
        ),
        build_prompt_section(
            "error_handling",
            "If a tool fails, explain the failure clearly to the user.\n"
            "Do not switch to risky workarounds such as sudo, chmod, writing outside "
            "allowed paths, or changing permissions.\n"
            "If the failure came from an obvious mistake in your immediately previous "
            "tool call, you may correct it once with the same safe tool.\n"
            "If the failure needs user action or is permission-related, stop and tell "
            "the user exactly what is blocked.",
        ),
    ]

    # Rich content section
    sections.append(
        build_prompt_section(
            "rich_content",
            """When your response includes specific locations or addresses, embed them using a fenced code block:
```rich-map
{"address": "full address here", "label": "optional label"}
```

When describing products with known details, embed them as:
```rich-product
{"name": "Product Name", "price": 29.99, "image": "https://...", "currency": "USD", "url": "https://..."}
```

When displaying an inline image, use:
```rich-image
{"src": "https://...", "alt": "description"}
```

When sharing a YouTube video, embed it as:
```rich-youtube
{"url": "https://www.youtube.com/watch?v=VIDEO_ID", "title": "Video Title"}
```
You can also use {"videoId": "VIDEO_ID"} directly instead of the full URL.
IMPORTANT: Only use rich-youtube with URLs obtained from tool results (web search, etc.) or provided by the user. NEVER fabricate or guess YouTube URLs or video IDs.

When the user asks you to create a web page, UI component, interactive demo, or any visual HTML content, embed it as:
```rich-html
<html>
<head>
  <style>/* CSS here */</style>
</head>
<body>
  <!-- HTML here -->
  <script>/* JS here */</script>
</body>
</html>
```
Guidelines for rich-html:
- Write complete, self-contained HTML documents.
- Include all CSS inline via <style> tags and all JS inline via <script> tags.
- Do not use external stylesheets, scripts, or CDN links — the preview is sandboxed.
- Use modern CSS (flexbox, grid, animations) for layouts and styling.

Rules:
- Only use rich blocks when you have concrete, verified data.
- Do not fabricate prices, images, URLs, or YouTube video IDs. Only use URLs from tool results or user input.
- You can use multiple rich blocks in a single response.
- Always include surrounding text or context; do not respond with only a rich block.""",
        )
    )

    capabilities_section = _build_capabilities_section(capabilities)
    if capabilities_section:
        sections.append(capabilities_section)

    return "\n\n".join(sections)
