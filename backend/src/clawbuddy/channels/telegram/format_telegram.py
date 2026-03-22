"""Convert Markdown (as typically produced by LLMs) to Telegram-compatible HTML.

Replaces: apps/api/src/channels/telegram/format-telegram.ts

Telegram supports a limited subset of HTML: <b>, <i>, <code>, <pre>, <a>.
This module converts common Markdown patterns to that subset, handles
code block extraction to prevent double-escaping, and splits long messages
respecting the 4096-character Telegram limit while repairing open tags.
"""

from __future__ import annotations

import re

_PLACEHOLDER = "\x00"


def _escape_html(text: str) -> str:
    """Escape HTML special characters."""
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def markdown_to_telegram_html(md: str) -> str:
    """Convert Markdown text to Telegram-compatible HTML.

    Processing order:
    1. Extract fenced code blocks (``` ... ```)
    2. Extract inline code (` ... `)
    3. Escape remaining HTML
    4. Convert headings, bold, bullets, italic, links
    5. Restore code placeholders
    """
    code_blocks: list[str] = []
    inline_codes: list[str] = []

    # 1. Extract fenced code blocks
    def _replace_code_block(m: re.Match[str]) -> str:
        content = m.group(1).rstrip("\n")
        idx = len(code_blocks)
        code_blocks.append(_escape_html(content))
        return f"{_PLACEHOLDER}CODEBLOCK_{idx}{_PLACEHOLDER}"

    text = re.sub(r"```(?:\w*)\n?([\s\S]*?)```", _replace_code_block, md)

    # 2. Extract inline code
    def _replace_inline_code(m: re.Match[str]) -> str:
        content = m.group(1)
        idx = len(inline_codes)
        inline_codes.append(_escape_html(content))
        return f"{_PLACEHOLDER}INLINECODE_{idx}{_PLACEHOLDER}"

    text = re.sub(r"`([^`\n]+)`", _replace_inline_code, text)

    # 3. Escape HTML in remaining text
    text = _escape_html(text)

    # 4. Headings -> bold
    text = re.sub(r"^#{1,6}\s+(.+)$", r"<b>\1</b>", text, flags=re.MULTILINE)

    # 5. Bold **text**
    text = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text)

    # 6. Bullets (before italic so `* item` isn't confused)
    text = re.sub(r"^[*\-]\s+", "• ", text, flags=re.MULTILINE)

    # 7. Italic *text* — require non-space after opening and before closing
    text = re.sub(
        r"(?<![*\w])\*(?!\s)(.+?)(?<!\s)\*(?![*\w])",
        r"<i>\1</i>",
        text,
    )

    # 8. Links [text](url)
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', text)

    # 9. Restore code block placeholders
    def _restore_code_block(m: re.Match[str]) -> str:
        idx = int(m.group(1))
        return f"<pre>{code_blocks[idx]}</pre>"

    text = re.sub(
        rf"{_PLACEHOLDER}CODEBLOCK_(\d+){_PLACEHOLDER}",
        _restore_code_block,
        text,
    )

    # 10. Restore inline code placeholders
    def _restore_inline_code(m: re.Match[str]) -> str:
        idx = int(m.group(1))
        return f"<code>{inline_codes[idx]}</code>"

    text = re.sub(
        rf"{_PLACEHOLDER}INLINECODE_(\d+){_PLACEHOLDER}",
        _restore_inline_code,
        text,
    )

    return text


def _get_unclosed_tags(html: str) -> list[str]:
    """Return the stack of tag names that are opened but not closed."""
    stack: list[str] = []
    for m in re.finditer(r"</?([a-z]+)[^>]*>", html, re.IGNORECASE):
        full = m.group(0)
        tag_name = m.group(1).lower()
        if full.startswith("</"):
            # Closing tag — pop from stack if it matches
            for i in range(len(stack) - 1, -1, -1):
                if stack[i] == tag_name:
                    stack.pop(i)
                    break
        else:
            stack.append(tag_name)
    return stack


def split_html_message(html: str, max_length: int = 4096) -> list[str]:
    """Split an HTML message respecting the Telegram 4096-char limit.

    Closes and reopens any open tags at split boundaries so each
    chunk is valid HTML on its own.
    """
    if len(html) <= max_length:
        return [html]

    parts: list[str] = []
    remaining = html

    while remaining:
        if len(remaining) <= max_length:
            parts.append(remaining)
            break

        # Find a split point at a newline
        split_idx = remaining.rfind("\n", 0, max_length)
        if split_idx <= 0:
            split_idx = max_length

        chunk = remaining[:split_idx]
        remaining = remaining[split_idx:].lstrip()

        # Repair unclosed tags
        open_tags = _get_unclosed_tags(chunk)
        if open_tags:
            # Close tags in reverse order at end of chunk
            chunk += "".join(f"</{t}>" for t in reversed(open_tags))
            # Reopen tags at start of next chunk
            remaining = "".join(f"<{t}>" for t in open_tags) + remaining

        parts.append(chunk)

    return parts


def split_plain_message(text: str, max_length: int = 4096) -> list[str]:
    """Split a plain-text message at newline boundaries."""
    if len(text) <= max_length:
        return [text]

    parts: list[str] = []
    remaining = text
    while remaining:
        if len(remaining) <= max_length:
            parts.append(remaining)
            break
        split_idx = remaining.rfind("\n", 0, max_length)
        if split_idx <= 0:
            split_idx = max_length
        parts.append(remaining[:split_idx])
        remaining = remaining[split_idx:].lstrip()
    return parts


def strip_markdown(text: str) -> str:
    """Strip Markdown formatting to produce plain text (fallback)."""
    result = re.sub(r"#{1,6}\s+", "", text)
    result = result.replace("**", "")
    result = re.sub(r"(?<!\w)\*(?!\s)", "", result)
    return result
