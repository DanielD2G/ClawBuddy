"""Sub-agent graph — simplified agent loop for delegated tasks.

Replaces: apps/api/src/services/sub-agent.service.ts + sub-agent-roles.ts + sub-agent.types.ts
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Awaitable

from loguru import logger
from sqlalchemy.ext.asyncio import AsyncSession

from clawbuddy.constants import PARALLEL_SAFE_TOOLS
from clawbuddy.graph.nodes.llm_call import check_tool_arg_size, record_token_usage
from clawbuddy.graph.nodes.result_processing import maybe_truncate_output
from clawbuddy.graph.tools import resolve_tool_capability
from clawbuddy.services.capability import capability_service
from clawbuddy.services.secret_redaction import SecretInventory, secret_redaction_service
from clawbuddy.services.settings_service import settings_service
from clawbuddy.services.tool_executor import (
    ExecutionContext,
    tool_executor_service,
)


# ---------------------------------------------------------------------------
# Sub-agent role configuration
# ---------------------------------------------------------------------------

@dataclass
class SubAgentRoleConfig:
    role: str
    description: str
    model_tier: str  # "explore" | "execute" | "light" | "primary"
    read_only: bool
    allowed_tools: list[str] | str  # list of tool names, or "all"
    denied_tools: list[str] = field(default_factory=list)


SUB_AGENT_ROLES: dict[str, SubAgentRoleConfig] = {
    "explore": SubAgentRoleConfig(
        role="explore",
        description=(
            "Fast, read-only agent for information gathering: searching documents, "
            "reading files, web searches, and browsing. Uses a cheaper/faster model."
        ),
        model_tier="explore",
        read_only=True,
        allowed_tools=[
            "search_documents",
            "web_search",
            "run_bash",
            "run_browser_script",
            "discover_tools",
        ],
    ),
    "analyze": SubAgentRoleConfig(
        role="analyze",
        description=(
            "Read-only agent for data analysis and summarization. Can run Python "
            "code in a sandboxed environment and search documents."
        ),
        model_tier="light",
        read_only=True,
        allowed_tools=["search_documents", "run_bash", "run_python"],
    ),
    "execute": SubAgentRoleConfig(
        role="execute",
        description=(
            "Full-capability agent for complex multi-step tasks. Has access to all "
            "workspace tools including bash, file writing, and code execution."
        ),
        model_tier="execute",
        read_only=False,
        allowed_tools="all",
        denied_tools=["delegate_task"],
    ),
}


# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------

@dataclass
class SubAgentResult:
    role: str
    success: bool
    result: str
    tool_executions: list[dict[str, Any]] = field(default_factory=list)
    iterations_used: int = 0
    token_usage: dict[str, int] | None = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def filter_tools(
    all_tools: list[dict[str, Any]],
    role_config: SubAgentRoleConfig,
) -> list[dict[str, Any]]:
    """Filter tool definitions based on role configuration."""
    if role_config.allowed_tools == "all":
        denied = set(role_config.denied_tools)
        return [t for t in all_tools if t.get("name") not in denied]
    allowed = set(role_config.allowed_tools)
    return [t for t in all_tools if t.get("name") in allowed]


def _build_sub_agent_system_prompt(
    role: str,
    task: str,
    context: str | None,
    capability_prompts: str,
    preferred_tools: list[str] | None = None,
) -> str:
    """Build system prompt for a sub-agent."""
    parts = [
        f'You are a focused sub-agent with the role "{role}". Complete the '
        "task below and return a clear, concise summary of your findings or actions.",
        "",
        "## Task",
        task,
    ]

    if context:
        parts.extend(["", "## Context from parent agent", context])

    if capability_prompts:
        parts.extend(["", "## Available tool instructions", capability_prompts])

    parts.extend([
        "",
        "## Guidelines",
        "- Stay focused on the task. Do not deviate.",
        "- **Batch independent tool calls in a single response.** If you need "
        "multiple searches, fetches, or reads that do not depend on each other, "
        "call them all at once. This runs them concurrently.",
        "- When done, provide a structured summary of what you found or accomplished.",
        "- If a tool fails, report the error and move on. Do not retry indefinitely.",
    ])

    if preferred_tools:
        parts.extend([
            "",
            "## Required tools",
            f"The user explicitly requested the following tools: {', '.join(preferred_tools)}.",
            "You MUST use these tools to complete the task. Do NOT substitute with "
            "alternative tools unless the required tool fails.",
        ])

    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Main runner
# ---------------------------------------------------------------------------

async def run_sub_agent(
    *,
    role: str,
    task: str,
    context: str | None = None,
    workspace_id: str,
    session_id: str,
    db: AsyncSession,
    secret_inventory: SecretInventory,
    emit: Callable[..., Awaitable[None]] | None = None,
    capabilities: list[dict[str, Any]] | None = None,
    sub_agent_id: str | None = None,
    browser_session_id: str | None = None,
    preferred_tools: list[str] | None = None,
    abort_event: asyncio.Event | None = None,
) -> dict[str, Any]:
    """Run a sub-agent with a simplified agent loop.

    Returns a dict matching SubAgentResult fields (serializable).
    """
    role_config = SUB_AGENT_ROLES.get(role)
    if not role_config:
        return {
            "role": role,
            "success": False,
            "result": f"Unknown sub-agent role: {role}",
            "toolExecutions": [],
            "iterationsUsed": 0,
        }

    # Get max iterations from settings
    max_iterations_map = {
        "explore": settings_service.get_sub_agent_explore_max_iterations,
        "analyze": settings_service.get_sub_agent_analyze_max_iterations,
        "execute": settings_service.get_sub_agent_execute_max_iterations,
    }
    getter = max_iterations_map.get(role, settings_service.get_sub_agent_explore_max_iterations)
    max_iterations = await getter()

    if emit:
        await emit("sub_agent_start", {
            "subAgentId": sub_agent_id or task,
            "role": role,
            "task": task,
        })

    # Create LLM for this role's tier
    from clawbuddy.providers.llm_factory import create_chat_model

    llm = await create_chat_model(role=role_config.model_tier)

    # Resolve capabilities and tools
    if not capabilities:
        capabilities = await capability_service.get_enabled_capabilities_for_workspace(
            db, workspace_id
        )
    all_tools = capability_service.build_tool_definitions(capabilities)
    tools = filter_tools(all_tools, role_config)

    if not tools:
        result_msg = "No tools available for this sub-agent role in the current workspace."
        if emit:
            await emit("sub_agent_done", {
                "subAgentId": sub_agent_id or task,
                "role": role,
                "summary": result_msg,
            })
        return {
            "role": role,
            "success": False,
            "result": result_msg,
            "toolExecutions": [],
            "iterationsUsed": 0,
        }

    # Build capability prompts for allowed tools
    allowed_names = {t.get("name") for t in tools}
    relevant_caps = [
        cap for cap in capabilities
        if any(
            t.get("name") in allowed_names
            for t in (cap.get("toolDefinitions") or [])
        )
    ]
    cap_prompts = "\n\n".join(
        f"### {c.get('name', '')}\n{c.get('systemPrompt', '')}"
        for c in relevant_caps
        if c.get("systemPrompt")
    )

    system_prompt = _build_sub_agent_system_prompt(
        role, task, context, cap_prompts, preferred_tools
    )

    # Build LangChain messages
    from langchain_core.messages import (
        AIMessage,
        HumanMessage,
        SystemMessage,
        ToolMessage,
    )

    lc_messages: list[Any] = [
        SystemMessage(content=system_prompt),
        HumanMessage(content=task),
    ]

    # Build tool schemas for binding
    tool_schemas = [
        {
            "type": "function",
            "function": {
                "name": t["name"],
                "description": t["description"],
                "parameters": t.get("parameters", {"type": "object", "properties": {}}),
            },
        }
        for t in tools
    ]

    tool_execution_log: list[dict[str, Any]] = []
    total_usage = {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0}
    # Internal messages for tracking (non-LangChain format)
    raw_messages: list[dict[str, Any]] = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": task},
    ]

    for i in range(max_iterations):
        if abort_event and abort_event.is_set():
            break

        if emit:
            await emit("thinking", {
                "message": f"Sub-agent ({role}) thinking...",
                "subAgent": role,
            })

        # Invoke LLM
        bound_llm = llm.bind_tools(tool_schemas) if tool_schemas else llm
        response = await bound_llm.ainvoke(lc_messages)

        # Track token usage
        usage_meta = getattr(response, "usage_metadata", None)
        if usage_meta:
            input_t = getattr(usage_meta, "input_tokens", 0)
            output_t = getattr(usage_meta, "output_tokens", 0)
            total_usage["inputTokens"] += input_t
            total_usage["outputTokens"] += output_t
            total_usage["totalTokens"] += input_t + output_t

            provider_id = getattr(llm, "_provider_id", "unknown")
            model_id = getattr(llm, "model_name", "") or getattr(llm, "model", "unknown")
            await record_token_usage(
                {"inputTokens": input_t, "outputTokens": output_t, "totalTokens": input_t + output_t},
                session_id, provider_id, model_id, db,
                update_session_context=False,
            )

        # Extract content
        content = response.content or ""
        if isinstance(content, list):
            content = "".join(
                b.get("text", "") if isinstance(b, dict) else str(b)
                for b in content
            )

        tool_calls = getattr(response, "tool_calls", None) or []

        # No tool calls — done
        if not tool_calls:
            if emit:
                await emit("sub_agent_done", {
                    "subAgentId": sub_agent_id or task,
                    "role": role,
                    "summary": content[:500],
                })
            return {
                "role": role,
                "success": True,
                "result": content,
                "toolExecutions": tool_execution_log,
                "iterationsUsed": i + 1,
                "tokenUsage": total_usage,
            }

        # Add assistant message with tool calls
        lc_messages.append(AIMessage(
            content=content,
            tool_calls=[
                {"id": tc["id"], "name": tc["name"], "args": tc.get("args", {})}
                for tc in tool_calls
            ],
        ))

        # Execute tool calls
        ctx = ExecutionContext(
            workspace_id=workspace_id,
            chat_session_id=session_id,
            db=db,
            secret_inventory=secret_inventory,
            browser_session_id=browser_session_id,
            emit=emit,
            capabilities=capabilities,
            abort_event=abort_event,
        )

        for tc in tool_calls:
            tc_name = tc.get("name", "")
            tc_id = tc.get("id", "")
            tc_args = tc.get("args", {})

            cap_slug = resolve_tool_capability(tc_name, capabilities) or "unknown"

            # Size guard
            size_rejection = check_tool_arg_size(tc_name, tc_args)
            if size_rejection:
                lc_messages.append(ToolMessage(
                    content=size_rejection,
                    tool_call_id=tc_id,
                ))
                continue

            # Execute
            if emit:
                public_args = secret_redaction_service.redact_for_public_storage(
                    tc_args, secret_inventory
                )
                await emit("tool_start", {
                    "toolCallId": tc_id,
                    "toolName": tc_name,
                    "capabilitySlug": cap_slug,
                    "input": public_args,
                    "subAgent": role,
                })

            result = await tool_executor_service.execute(
                tool_name=tc_name,
                tool_call_id=tc_id,
                arguments=tc_args,
                capability_slug=cap_slug,
                ctx=ctx,
            )

            if emit:
                await emit("tool_result", {
                    "toolCallId": tc_id,
                    "toolName": tc_name,
                    "output": (result.output or "")[:2000],
                    "error": result.error,
                    "exitCode": result.exit_code,
                    "durationMs": result.duration_ms,
                    "subAgent": role,
                })

            # Truncate output for context
            tool_output = maybe_truncate_output(result.output or "")
            tool_content = tool_output if tool_output else (result.error or "No output")

            lc_messages.append(ToolMessage(
                content=tool_content,
                tool_call_id=tc_id,
            ))

            # Log execution
            public_input = secret_redaction_service.redact_for_public_storage(
                tc_args, secret_inventory
            )
            tool_execution_log.append({
                "toolName": tc_name,
                "capabilitySlug": cap_slug,
                "input": public_input,
                "output": result.output[:2000] if result.output else None,
                "error": result.error,
                "durationMs": result.duration_ms,
            })

    # Max iterations reached
    if emit:
        await emit("sub_agent_done", {
            "subAgentId": sub_agent_id or task,
            "role": role,
            "summary": f"Max iterations ({max_iterations}) reached",
        })

    return {
        "role": role,
        "success": False,
        "result": f"Sub-agent reached maximum iterations ({max_iterations}). Partial results may be available in tool outputs above.",
        "toolExecutions": tool_execution_log,
        "iterationsUsed": max_iterations,
        "tokenUsage": total_usage,
    }
