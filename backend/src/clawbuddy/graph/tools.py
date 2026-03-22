"""Tool adapter — converts capability definitions to LangChain tools.

Replaces: Tool definition building from capability.service.ts
"""

from __future__ import annotations

from typing import Any

from langchain_core.tools import StructuredTool


def _build_args_schema(parameters: dict[str, Any]) -> dict[str, Any]:
    """Build a JSON schema compatible dict for tool args."""
    return parameters if parameters else {"type": "object", "properties": {}}


def capability_tools_to_langchain(
    capabilities: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Convert capability tool definitions to LangChain-compatible tool dicts.

    Returns a list of dicts with name, description, parameters — suitable for
    ``model.bind_tools()`` or building ``StructuredTool`` instances.
    """
    tools: list[dict[str, Any]] = []
    for cap in capabilities:
        for tool_def in cap.get("toolDefinitions", []) or []:
            tools.append({
                "name": tool_def["name"],
                "description": tool_def["description"],
                "parameters": _build_args_schema(tool_def.get("parameters", {})),
            })
    return tools


def resolve_tool_capability(
    tool_name: str,
    capabilities: list[dict[str, Any]],
) -> str | None:
    """Map a tool name back to its capability slug."""
    for cap in capabilities:
        for tool_def in cap.get("toolDefinitions", []) or []:
            if tool_def.get("name") == tool_name:
                return cap.get("slug")
    return None


def build_tool_definitions_for_binding(
    capabilities: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Build OpenAI function-calling-style tool definitions for LLM binding.

    Returns list of dicts with ``type``, ``function`` keys as expected by
    LangChain's ``bind_tools`` when using raw dicts.
    """
    tools: list[dict[str, Any]] = []
    for cap in capabilities:
        for tool_def in cap.get("toolDefinitions", []) or []:
            tools.append({
                "type": "function",
                "function": {
                    "name": tool_def["name"],
                    "description": tool_def["description"],
                    "parameters": _build_args_schema(tool_def.get("parameters", {})),
                },
            })
    return tools
