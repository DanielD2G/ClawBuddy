"""HTML → Markdown / plain-text conversion.

Replaces: apps/api/src/lib/html-to-markdown.ts
Uses ``markdownify`` instead of Turndown.
"""

from __future__ import annotations

import re

from markdownify import markdownify as md

# Tags to strip before conversion (non-content elements)
_STRIP_TAGS = ["script", "style", "noscript", "iframe", "nav", "footer", "header"]

# Pre-compiled patterns for html_to_text
_SCRIPT_RE = re.compile(r"<script[\s\S]*?</script>", re.IGNORECASE)
_STYLE_RE = re.compile(r"<style[\s\S]*?</style>", re.IGNORECASE)
_TAG_RE = re.compile(r"<[^>]+>")
_WHITESPACE_RE = re.compile(r"\s+")

# Patterns to strip non-content tags before markdownify
_STRIP_TAG_PATTERNS = [
    re.compile(rf"<{tag}[\s\S]*?</{tag}>", re.IGNORECASE) for tag in _STRIP_TAGS
]


def html_to_markdown(html: str) -> str:
    """Convert HTML to Markdown, stripping non-content elements."""
    cleaned = html
    for pattern in _STRIP_TAG_PATTERNS:
        cleaned = pattern.sub("", cleaned)

    return md(
        cleaned,
        heading_style="ATX",
        code_language_callback=None,
        bullets="-",
        strip=_STRIP_TAGS,
    )


def html_to_text(html: str) -> str:
    """Convert HTML to plain text by stripping all tags and decoding entities."""
    result = _SCRIPT_RE.sub("", html)
    result = _STYLE_RE.sub("", result)
    result = _TAG_RE.sub(" ", result)
    result = result.replace("&nbsp;", " ")
    result = result.replace("&amp;", "&")
    result = result.replace("&lt;", "<")
    result = result.replace("&gt;", ">")
    result = result.replace("&quot;", '"')
    result = _WHITESPACE_RE.sub(" ", result)
    return result.strip()
