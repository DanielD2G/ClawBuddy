"""Graph edge functions — conditional routing helpers.

While the current implementation uses an imperative loop rather than
a LangGraph StateGraph, these edge functions encapsulate the routing
logic that determines flow between agent steps.
"""

from __future__ import annotations

from typing import Any

from clawbuddy.graph.state import AgentGraphState


def should_continue(state: AgentGraphState, tool_calls: list[dict[str, Any]]) -> str:
    """Determine next step after LLM response.

    Returns:
        "tool_approval" if there are tool calls to process
        "save_message" if no tool calls (final response)
        "abort" if the agent was aborted
    """
    if state.is_aborted:
        return "abort"
    if tool_calls:
        return "tool_approval"
    return "save_message"


def after_tools(state: AgentGraphState, iteration: int, max_iterations: int) -> str:
    """Determine next step after tool execution.

    Returns:
        "continue" to run another LLM iteration
        "save_message" if max iterations reached
        "abort" if the agent was aborted
    """
    if state.is_aborted:
        return "abort"
    if iteration >= max_iterations - 1:
        return "save_message"
    return "continue"


def after_approval(approved: bool) -> str:
    """Determine next step after tool approval check.

    Returns:
        "tool_execution" if approved
        "pause" if approval is needed (agent should pause)
    """
    return "tool_execution" if approved else "pause"
