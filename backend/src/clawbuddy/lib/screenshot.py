"""Screenshot extraction from tool outputs.

Replaces: apps/api/src/lib/screenshot.ts
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
from typing import Any

import orjson


@dataclass(frozen=True, slots=True)
class ScreenshotResult:
    """Result of screenshot extraction."""

    screenshot_b64: str | None
    description: str | None


def extract_screenshot_base64(output: str) -> ScreenshotResult:
    """Extract a base64-encoded screenshot from a JSON tool output string.

    Handles both raw base64 strings and Buffer-serialized screenshots
    (``{"type": "Buffer", "data": [...]}``).

    Returns a :class:`ScreenshotResult` with None values if the output is
    not JSON or contains no screenshot.
    """
    try:
        parsed: dict[str, Any] = orjson.loads(output)
    except (orjson.JSONDecodeError, TypeError, ValueError):
        return ScreenshotResult(screenshot_b64=None, description=None)

    screenshot_b64: str | None = None
    screenshot = parsed.get("screenshot")

    if isinstance(screenshot, str):
        screenshot_b64 = screenshot
    elif isinstance(screenshot, dict):
        # Handle Node.js Buffer serialization: {"type": "Buffer", "data": [...]}
        if screenshot.get("type") == "Buffer" and isinstance(screenshot.get("data"), list):
            raw_bytes = bytes(screenshot["data"])
            screenshot_b64 = base64.b64encode(raw_bytes).decode("ascii")

    if screenshot_b64:
        description = parsed.get("description") or parsed.get("content") or None
        return ScreenshotResult(screenshot_b64=screenshot_b64, description=description)

    return ScreenshotResult(screenshot_b64=None, description=None)
