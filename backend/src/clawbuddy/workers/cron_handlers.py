"""Cron handler registry — maps handler names to async functions.

Replaces: apps/api/src/workers/cron-handlers.ts
"""

from __future__ import annotations

from typing import Callable, Awaitable


async def _cleanup_idle_containers() -> None:
    """Stop workspace containers idle for more than 10 minutes."""
    from clawbuddy.services.sandbox import sandbox_service

    await sandbox_service.cleanup_idle_containers()


# Handler registry — maps handler name to async function
CRON_HANDLERS: dict[str, Callable[[], Awaitable[None]]] = {
    "cleanupIdleContainers": _cleanup_idle_containers,
}
