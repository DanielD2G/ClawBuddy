"""Tool Discovery capability.

Replaces: apps/api/src/capabilities/builtin/tool-discovery.ts
"""

from __future__ import annotations

from typing import Any

TOOL_DISCOVERY: dict[str, Any] = {
    "slug": "tool-discovery",
    "name": "Tool Discovery",
    "description": (
        "Dynamically discovers and loads relevant tools based on the user query. "
        "Activated automatically when many capabilities are enabled."
    ),
    "icon": "Search",
    "category": "builtin",
    "version": "1.0.0",
    "tools": [
        {
            "name": "discover_tools",
            "description": (
                "Search for available tools and capabilities that match what you "
                "need to do. Returns tool definitions and instructions that become "
                "available for subsequent calls."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": (
                            "Natural language description of what you need to do "
                            '(e.g. "run a python script", "execute AWS CLI commands", '
                            '"automate browser")'
                        ),
                    },
                    "list_all": {
                        "type": "boolean",
                        "description": (
                            "If true, returns a compact list of all available tool "
                            "names and descriptions instead of semantic search"
                        ),
                    },
                },
                "required": ["query"],
            },
        },
    ],
    "systemPrompt": (
        "You have a discover_tools tool to find and load specialized capabilities "
        "beyond the generic tools already available (bash, python, document search, memory).\n\n"
        "IMPORTANT: Before resorting to bash or python to accomplish a task, ALWAYS "
        "call discover_tools first to check if a more suitable, purpose-built tool "
        "exists. For example, do not use curl/wget in bash or requests/httpx in python "
        "for web searches — there may be a dedicated web_search tool. Do not write "
        "browser-automation scripts in python when a dedicated browser tool may exist. "
        "Specialized tools are faster, more reliable, and produce better results than "
        "generic workarounds.\n\n"
        "Only fall back to bash or python if discover_tools confirms no specialized "
        "tool is available for the task.\n\n"
        "After discover_tools returns, the relevant tools are available for the rest "
        "of this conversation — do NOT call discover_tools again for the same "
        "capability. If no relevant tools are found, try calling discover_tools with "
        "list_all: true to see all available capabilities."
    ),
    "sandbox": {},
}

# Backward-compatible alias used by runtime discovery code that still imports
# the older symbol name.
tool_discovery_capability = TOOL_DISCOVERY
