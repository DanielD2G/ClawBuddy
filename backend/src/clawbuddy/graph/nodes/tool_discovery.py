"""Tool discovery node — pre-flight discovery of relevant tools.

Replaces: Tool discovery logic from agent.service.ts
"""

from __future__ import annotations

from typing import Any

from loguru import logger

from clawbuddy.constants import (
    ALWAYS_ON_CAPABILITY_SLUGS,
    PREFLIGHT_DISCOVERY_SCORE_THRESHOLD,
    TOOL_DISCOVERY_THRESHOLD,
)
from clawbuddy.graph.state import AgentGraphState
from clawbuddy.services.system_prompt_builder import (
    build_capability_blocks,
    build_prompt_section,
)


async def run_preflight_discovery(
    state: AgentGraphState,
    user_content: str,
) -> dict[str, Any]:
    """Run pre-flight tool discovery based on user message.

    Returns dict with 'tools', 'system_prompt_addition', and
    'discovered_capabilities'.
    """
    capabilities = state.capabilities
    use_discovery = len(capabilities) >= TOOL_DISCOVERY_THRESHOLD

    if not use_discovery:
        return {
            "tools": [],
            "system_prompt_addition": "",
            "discovered_capabilities": [],
        }

    from clawbuddy.services.tool_discovery import tool_discovery_service

    # Get non-always-on capability slugs
    enabled_slugs = [
        cap.get("slug", "")
        for cap in capabilities
        if cap.get("slug") not in ALWAYS_ON_CAPABILITY_SLUGS
    ]

    # Search for relevant tools
    preflight_results = await tool_discovery_service.search(
        user_content,
        enabled_slugs,
        PREFLIGHT_DISCOVERY_SCORE_THRESHOLD,
    )

    if not preflight_results:
        return {
            "tools": [],
            "system_prompt_addition": "",
            "discovered_capabilities": [],
        }

    # Build discovered capabilities and tools
    discovered: list[dict[str, Any]] = []
    new_tools: list[dict[str, Any]] = []

    for cap in preflight_results:
        discovered.append({
            "slug": cap.slug,
            "name": cap.name,
            "toolDefinitions": cap.tools,
            "systemPrompt": cap.instructions,
            "networkAccess": cap.network_access,
            "skillType": cap.skill_type,
        })
        for tool in cap.tools:
            new_tools.append({
                "name": tool.get("name", ""),
                "description": tool.get("description", ""),
                "parameters": tool.get("parameters", {}),
            })

    # Build system prompt addition
    cap_prompts = build_capability_blocks([
        {"name": c.name, "systemPrompt": c.instructions}
        for c in preflight_results
    ])
    prompt_addition = f"\n\n{build_prompt_section('dynamically_loaded_capabilities', cap_prompts)}"

    logger.info(
        f"[Discovery] Pre-flight loaded: {[c.slug for c in preflight_results]}"
    )

    return {
        "tools": new_tools,
        "system_prompt_addition": prompt_addition,
        "discovered_capabilities": discovered,
    }
