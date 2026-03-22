"""Server-Sent Events (SSE) utilities.

Replaces: apps/api/src/lib/sse.ts
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, Callable, Coroutine
from typing import Any

import orjson
from loguru import logger
from sse_starlette.sse import EventSourceResponse
from starlette.responses import Response

# SSE event type literals matching the TypeScript SSEEvent union
SSE_EVENT_TYPES = {
    "thinking",
    "tool_start",
    "tool_result",
    "approval_required",
    "content",
    "title_update",
    "sources",
    "done",
    "error",
    "awaiting_approval",
    "session",
    "context_compressed",
    "compressing",
    "sub_agent_start",
    "sub_agent_done",
    "aborted",
}

# Type alias for the emit callback
SSEEmit = Callable[[str, dict[str, Any]], Coroutine[Any, Any, None]]


def create_sse_stream(
    handler: Callable[[SSEEmit], Coroutine[Any, Any, None]],
) -> Response:
    """Create an SSE streaming response.

    The handler receives an `emit` callback to push events.
    Events are serialized as JSON and sent as SSE.

    Args:
        handler: Async function that receives an emit callback and produces events.

    Returns:
        EventSourceResponse that streams events to the client.
    """
    queue: asyncio.Queue[dict[str, str] | None] = asyncio.Queue()

    async def emit(event: str, data: dict[str, Any]) -> None:
        """Push an SSE event to the stream."""
        try:
            serialized = orjson.dumps(data).decode("utf-8")
            await queue.put({"event": event, "data": serialized})
        except Exception as e:
            logger.warning(f"[SSE] Failed to emit event '{event}': {e}")

    async def run_handler() -> None:
        try:
            await handler(emit)
        except Exception as e:
            error_msg = str(e) if not isinstance(e, Exception) else e.__class__.__name__ + ": " + str(e)
            logger.error(f"[SSE] Handler error: {error_msg}")
            try:
                await emit("error", {"message": str(e)})
            except Exception:
                pass
        finally:
            await queue.put(None)  # Sentinel to signal end of stream

    async def event_generator() -> AsyncGenerator[dict[str, str], None]:
        task = asyncio.create_task(run_handler())
        try:
            while True:
                item = await queue.get()
                if item is None:
                    break
                yield item
        finally:
            if not task.done():
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

    return EventSourceResponse(
        event_generator(),
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )
