"""Agent graph state definition.

Replaces: Agent state management from apps/api/src/services/agent.service.ts
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Annotated, Callable, Awaitable

from langchain_core.messages import BaseMessage
from langgraph.graph.message import add_messages

from clawbuddy.services.agent_state import DocumentSource, ToolExecution
from clawbuddy.services.secret_redaction import SecretInventory


@dataclass
class ToolCallInfo:
    """A pending or completed tool call."""
    id: str
    name: str
    arguments: dict[str, Any]
    capability_slug: str = ""


@dataclass
class ToolResultInfo:
    """Result of a completed tool call."""
    tool_call_id: str
    content: str
    error: str | None = None


class AgentGraphState:
    """Mutable state container for the agent graph.

    Uses a class instead of TypedDict to support mutable fields and methods.
    The LangGraph StateGraph will wrap this via channels.
    """

    def __init__(
        self,
        *,
        messages: list[BaseMessage] | None = None,
        session_id: str = "",
        workspace_id: str = "",
        iteration: int = 0,
        max_iterations: int = 25,
        pending_tool_calls: list[ToolCallInfo] | None = None,
        completed_results: list[ToolResultInfo] | None = None,
        tool_executions: list[ToolExecution] | None = None,
        sources: list[DocumentSource] | None = None,
        emit: Callable[..., Awaitable[None]] | None = None,
        abort_event: asyncio.Event | None = None,
        secret_inventory: SecretInventory | None = None,
        context_summary: str | None = None,
        discovered_capability_slugs: list[str] | None = None,
        mentioned_slugs: list[str] | None = None,
        capabilities: list[dict[str, Any]] | None = None,
        allow_rules: list[str] | None = None,
        content: str = "",
        finish_reason: str = "",
        paused: bool = False,
        last_message_id: str | None = None,
        token_usage: dict[str, int] | None = None,
        db: Any = None,
    ) -> None:
        self.messages = messages or []
        self.session_id = session_id
        self.workspace_id = workspace_id
        self.iteration = iteration
        self.max_iterations = max_iterations
        self.pending_tool_calls = pending_tool_calls or []
        self.completed_results = completed_results or []
        self.tool_executions = tool_executions or []
        self.sources = sources or []
        self.emit = emit
        self.abort_event = abort_event
        self.secret_inventory = secret_inventory
        self.context_summary = context_summary
        self.discovered_capability_slugs = discovered_capability_slugs or []
        self.mentioned_slugs = mentioned_slugs or []
        self.capabilities = capabilities or []
        self.allow_rules = allow_rules or []
        self.content = content
        self.finish_reason = finish_reason
        self.paused = paused
        self.last_message_id = last_message_id
        self.token_usage = token_usage or {}
        self.db = db

    @property
    def is_aborted(self) -> bool:
        return self.abort_event is not None and self.abort_event.is_set()
