"""Agent state serialization and management.

Replaces: apps/api/src/services/agent-state.service.ts
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from clawbuddy.services.crypto import decrypt, encrypt
from clawbuddy.services.secret_redaction import SecretInventory, secret_redaction_service


# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------

@dataclass
class ToolExecution:
    """Record of a single tool execution during an agent loop."""
    tool_name: str
    capability_slug: str
    input: dict[str, Any]
    output: str | None = None
    error: str | None = None
    exit_code: int | None = None
    duration_ms: int = 0
    sub_agent_execution_ids: list[str] | None = None


@dataclass
class DocumentSource:
    """A source document reference from search results."""
    document_id: str
    document_title: str
    chunk_id: str
    chunk_index: int


@dataclass
class AgentResult:
    """Final result of an agent run."""
    content: str
    paused: bool = False
    tool_executions: list[ToolExecution] = field(default_factory=list)
    sources: list[DocumentSource] | None = None
    message_id: str | None = None
    last_message_id: str | None = None


@dataclass
class AgentState:
    """Serializable state for an agent run (for pause/resume)."""
    messages: list[dict[str, Any]]
    iteration: int
    pending_tool_calls: list[dict[str, Any]]
    completed_tool_results: list[dict[str, Any]]
    tool_execution_log: list[dict[str, Any]]
    workspace_id: str
    session_id: str
    discovered_capability_slugs: list[str] | None = None
    mentioned_slugs: list[str] | None = None


# ---------------------------------------------------------------------------
# Serialization
# ---------------------------------------------------------------------------

def serialize_encrypted_agent_state(state: AgentState) -> str:
    """Serialize and encrypt an AgentState for storage in the DB."""
    data = {
        "messages": state.messages,
        "iteration": state.iteration,
        "pendingToolCalls": state.pending_tool_calls,
        "completedToolResults": state.completed_tool_results,
        "toolExecutionLog": state.tool_execution_log,
        "workspaceId": state.workspace_id,
        "sessionId": state.session_id,
    }
    if state.discovered_capability_slugs is not None:
        data["discoveredCapabilitySlugs"] = state.discovered_capability_slugs
    if state.mentioned_slugs is not None:
        data["mentionedSlugs"] = state.mentioned_slugs
    return encrypt(json.dumps(data))


def deserialize_agent_state(
    agent_state: Any | None,
    agent_state_encrypted: str | None,
) -> AgentState | None:
    """Deserialize an AgentState from DB fields.

    Tries encrypted form first, then falls back to legacy plain JSON.
    """
    if agent_state_encrypted:
        try:
            raw = json.loads(decrypt(agent_state_encrypted))
            return _raw_to_agent_state(raw)
        except Exception:
            pass

    if agent_state and isinstance(agent_state, dict):
        return _raw_to_agent_state(agent_state)

    return None


def _raw_to_agent_state(raw: dict[str, Any]) -> AgentState:
    return AgentState(
        messages=raw.get("messages", []),
        iteration=raw.get("iteration", 0),
        pending_tool_calls=raw.get("pendingToolCalls", []),
        completed_tool_results=raw.get("completedToolResults", []),
        tool_execution_log=raw.get("toolExecutionLog", []),
        workspace_id=raw.get("workspaceId", ""),
        session_id=raw.get("sessionId", ""),
        discovered_capability_slugs=raw.get("discoveredCapabilitySlugs"),
        mentioned_slugs=raw.get("mentionedSlugs"),
    )


def build_public_agent_state(
    state: AgentState,
    inventory: SecretInventory,
) -> dict[str, Any]:
    """Build a redacted view of the agent state for the frontend."""
    return {
        "iteration": state.iteration,
        "workspaceId": state.workspace_id,
        "sessionId": state.session_id,
        "pendingToolCalls": [
            {
                "id": tc.get("id"),
                "name": tc.get("name"),
                "arguments": secret_redaction_service.redact_for_public_storage(
                    tc.get("arguments", {}), inventory
                ),
            }
            for tc in state.pending_tool_calls
        ],
    }
