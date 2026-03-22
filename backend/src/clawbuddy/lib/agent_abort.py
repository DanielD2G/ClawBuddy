"""In-memory registry of active agent loops.

Replaces: apps/api/src/lib/agent-abort.ts
Uses ``asyncio.Event`` instead of ``AbortController``.
"""

from __future__ import annotations

import asyncio


class _AgentLoopRegistry:
    """Thread-safe registry of active agent loops keyed by session ID.

    Each loop is associated with an :class:`asyncio.Event` that, when set,
    signals the agent graph to stop after the current iteration.
    """

    __slots__ = ("_loops",)

    def __init__(self) -> None:
        self._loops: dict[str, asyncio.Event] = {}

    def register(self, session_id: str) -> asyncio.Event:
        """Register a new agent loop and return its abort event.

        If a loop is already registered for *session_id*, it is aborted first.
        """
        existing = self._loops.get(session_id)
        if existing is not None:
            existing.set()  # signal the old loop to stop

        event = asyncio.Event()
        self._loops[session_id] = event
        return event

    def abort(self, session_id: str) -> bool:
        """Abort a running agent loop.

        Returns ``True`` if one was found and aborted.
        """
        event = self._loops.get(session_id)
        if event is None:
            return False
        event.set()
        del self._loops[session_id]
        return True

    def unregister(self, session_id: str) -> None:
        """Remove the registry entry on normal completion."""
        self._loops.pop(session_id, None)

    def is_running(self, session_id: str) -> bool:
        """Check if a loop is currently registered for a session."""
        return session_id in self._loops

    def is_aborted(self, session_id: str) -> bool:
        """Check if the loop for *session_id* has been aborted (event is set)."""
        event = self._loops.get(session_id)
        if event is None:
            return False
        return event.is_set()


# Module-level singleton
agent_loops = _AgentLoopRegistry()
