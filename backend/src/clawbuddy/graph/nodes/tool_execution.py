"""Tool execution node — executes tool calls via the tool executor service.

Replaces: Tool execution logic from agent.service.ts
"""

from __future__ import annotations

from typing import Any

from loguru import logger

from clawbuddy.constants import PARALLEL_SAFE_TOOLS
from clawbuddy.graph.state import AgentGraphState, ToolCallInfo, ToolResultInfo
from clawbuddy.graph.tools import resolve_tool_capability
from clawbuddy.services.tool_executor import (
    ExecutionContext,
    ToolExecutorService,
    tool_executor_service,
)


async def execute_tool_calls(
    state: AgentGraphState,
    tool_calls: list[ToolCallInfo],
) -> list[ToolResultInfo]:
    """Execute a batch of tool calls, respecting parallelism rules.

    Tools in PARALLEL_SAFE_TOOLS can run concurrently; others run sequentially.
    """
    import asyncio

    results: list[ToolResultInfo] = []
    ctx = ExecutionContext(
        workspace_id=state.workspace_id,
        chat_session_id=state.session_id,
        db=state.db,
        secret_inventory=state.secret_inventory,
        emit=state.emit,
        capabilities=state.capabilities,
        mentioned_slugs=state.mentioned_slugs,
        abort_event=state.abort_event,
    )

    # Separate parallel-safe and sequential tool calls
    parallel_calls: list[ToolCallInfo] = []
    sequential_calls: list[ToolCallInfo] = []

    for tc in tool_calls:
        if tc.name in PARALLEL_SAFE_TOOLS:
            parallel_calls.append(tc)
        else:
            sequential_calls.append(tc)

    # Execute parallel-safe tools concurrently
    if parallel_calls:
        async def _exec_one(tc: ToolCallInfo) -> ToolResultInfo:
            cap_slug = tc.capability_slug or resolve_tool_capability(
                tc.name, state.capabilities
            ) or "unknown"

            result = await tool_executor_service.execute(
                tool_name=tc.name,
                tool_call_id=tc.id,
                arguments=tc.arguments,
                capability_slug=cap_slug,
                ctx=ctx,
            )

            # Emit SSE events
            if state.emit:
                await state.emit("tool_result", {
                    "toolCallId": tc.id,
                    "toolName": tc.name,
                    "output": result.output[:2000] if result.output else "",
                    "error": result.error,
                    "exitCode": result.exit_code,
                    "durationMs": result.duration_ms,
                    "executionId": result.execution_id,
                })

            # Record in state
            from clawbuddy.services.agent_state import ToolExecution

            state.tool_executions.append(
                ToolExecution(
                    tool_name=tc.name,
                    capability_slug=cap_slug,
                    input=tc.arguments,
                    output=result.output if result.output else None,
                    error=result.error,
                    exit_code=result.exit_code,
                    duration_ms=result.duration_ms,
                    sub_agent_execution_ids=result.sub_agent_execution_ids,
                )
            )

            if result.sources:
                for src in result.sources:
                    state.sources.append(src)

            return ToolResultInfo(
                tool_call_id=tc.id,
                content=result.output or result.error or "",
                error=result.error,
            )

        parallel_results = await asyncio.gather(
            *[_exec_one(tc) for tc in parallel_calls]
        )
        results.extend(parallel_results)

    # Execute sequential tools one at a time
    for tc in sequential_calls:
        if state.is_aborted:
            results.append(
                ToolResultInfo(
                    tool_call_id=tc.id,
                    content="Agent loop was cancelled.",
                    error="Aborted",
                )
            )
            continue

        cap_slug = tc.capability_slug or resolve_tool_capability(
            tc.name, state.capabilities
        ) or "unknown"

        # Emit tool_start
        if state.emit:
            from clawbuddy.services.secret_redaction import secret_redaction_service

            public_input = secret_redaction_service.redact_for_public_storage(
                tc.arguments, state.secret_inventory
            ) if state.secret_inventory else tc.arguments

            await state.emit("tool_start", {
                "toolCallId": tc.id,
                "toolName": tc.name,
                "capabilitySlug": cap_slug,
                "input": public_input,
            })

        result = await tool_executor_service.execute(
            tool_name=tc.name,
            tool_call_id=tc.id,
            arguments=tc.arguments,
            capability_slug=cap_slug,
            ctx=ctx,
        )

        # Emit tool_result
        if state.emit:
            await state.emit("tool_result", {
                "toolCallId": tc.id,
                "toolName": tc.name,
                "output": result.output[:2000] if result.output else "",
                "error": result.error,
                "exitCode": result.exit_code,
                "durationMs": result.duration_ms,
                "executionId": result.execution_id,
            })

        from clawbuddy.services.agent_state import ToolExecution

        state.tool_executions.append(
            ToolExecution(
                tool_name=tc.name,
                capability_slug=cap_slug,
                input=tc.arguments,
                output=result.output if result.output else None,
                error=result.error,
                exit_code=result.exit_code,
                duration_ms=result.duration_ms,
                sub_agent_execution_ids=result.sub_agent_execution_ids,
            )
        )

        if result.sources:
            for src in result.sources:
                state.sources.append(src)

        results.append(
            ToolResultInfo(
                tool_call_id=tc.id,
                content=result.output or result.error or "",
                error=result.error,
            )
        )

    return results
