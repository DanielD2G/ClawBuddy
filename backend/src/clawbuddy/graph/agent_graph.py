"""Main agent graph — orchestrates the full agent loop.

Replaces: apps/api/src/services/agent.service.ts (runAgentLoop)

This uses an imperative loop pattern (like the original TS code) rather than
a LangGraph StateGraph, because the agent's control flow (approval pausing,
discovery mode, context compression) maps more naturally to an async loop
with explicit state management. The graph nodes are called as functions.
"""

from __future__ import annotations

import asyncio
from typing import Any, Callable, Awaitable

from loguru import logger
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from clawbuddy.constants import (
    ALWAYS_ON_CAPABILITY_SLUGS,
    DELEGATION_ONLY_TOOLS,
    MAX_AGENT_DOCUMENTS,
    TOOL_DISCOVERY_THRESHOLD,
)
from clawbuddy.db.models import (
    ChatMessage,
    ChatSession,
    Document,
    GlobalSettings,
    WorkspaceCapability,
)
from clawbuddy.graph.nodes.context_compression import run_context_compression
from clawbuddy.graph.nodes.llm_call import (
    check_tool_arg_size,
    content_overlap_ratio,
    prune_old_tool_results,
    record_token_usage,
)
from clawbuddy.graph.nodes.result_processing import (
    build_tool_result_content,
    maybe_truncate_output,
)
from clawbuddy.graph.nodes.save_message import (
    save_agent_state_for_approval,
    save_assistant_message,
    save_user_message,
)
from clawbuddy.graph.nodes.title_generation import maybe_generate_title
from clawbuddy.graph.nodes.tool_approval import check_tool_approval
from clawbuddy.graph.nodes.tool_discovery import run_preflight_discovery
from clawbuddy.graph.nodes.tool_execution import execute_tool_calls
from clawbuddy.graph.state import AgentGraphState, ToolCallInfo
from clawbuddy.graph.tools import resolve_tool_capability
from clawbuddy.lib.sanitize import strip_null_bytes
from clawbuddy.services.agent_debug import create_session_logger
from clawbuddy.services.agent_state import AgentResult, DocumentSource, ToolExecution
from clawbuddy.services.capability import capability_service
from clawbuddy.services.secret_redaction import (
    SecretInventory,
    secret_redaction_service,
)
from clawbuddy.services.settings_service import settings_service
from clawbuddy.services.system_prompt_builder import (
    build_capability_blocks,
    build_prompt_section,
    build_system_prompt,
)
from clawbuddy.services.tool_discovery import DiscoveredCapability


def _build_conversation_messages(
    *,
    system_prompt: str,
    summary: str | None,
    recent_messages: list[dict[str, Any]],
    current_user_content: str,
    history_includes_current: bool = False,
) -> list[dict[str, Any]]:
    """Build the message list for the LLM call."""
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": system_prompt},
    ]

    # Add summary as context
    if summary:
        messages.append({
            "role": "system",
            "content": f"<conversation_summary>\n{summary}\n</conversation_summary>",
        })

    # Add recent history
    for msg in recent_messages:
        messages.append({
            "role": msg.get("role", "user"),
            "content": msg.get("content", ""),
        })

    # Add current user message if not already in history
    if not history_includes_current:
        messages.append({
            "role": "user",
            "content": current_user_content,
        })

    return messages


async def run_agent_loop(
    session_id: str,
    user_content: str,
    workspace_id: str,
    db: AsyncSession,
    emit: Callable[..., Awaitable[None]] | None = None,
    *,
    auto_approve: bool = False,
    mentioned_slugs: list[str] | None = None,
    secret_inventory: SecretInventory | None = None,
    history_includes_current_user_message: bool = False,
    abort_event: asyncio.Event | None = None,
) -> AgentResult:
    """Run the full agent loop with tool calling and SSE streaming.

    This is the main entry point that replaces agentService.runAgentLoop().
    """
    # Build secret inventory
    inventory = secret_inventory or await secret_redaction_service.build_secret_inventory(
        db, workspace_id
    )
    safe_user_content = secret_redaction_service.redact_for_public_storage(
        user_content, inventory
    )
    session_logger = create_session_logger(session_id, inventory)
    session_logger.debug_log("runAgentLoop START", {
        "sessionId": session_id,
        "workspaceId": workspace_id,
        "userContent": str(safe_user_content)[:200],
    })

    if emit:
        await emit("thinking", {"message": "Thinking..."})

    # Get workspace-scoped capabilities
    capabilities = await capability_service.get_enabled_capabilities_for_workspace(
        db, workspace_id
    )

    # Discovery mode
    use_discovery = len(capabilities) >= TOOL_DISCOVERY_THRESHOLD

    # Build tools and system prompt
    timezone = await settings_service.get_timezone()
    tool_defs: list[dict[str, Any]]
    system_prompt: str
    discovered_capabilities: list[DiscoveredCapability] = []

    if use_discovery:
        from clawbuddy.services.tool_discovery import tool_discovery_service

        ctx = tool_discovery_service.build_discovery_context(
            capabilities, mentioned_slugs, timezone
        )
        tool_defs = ctx.tools
        system_prompt = ctx.system_prompt
    else:
        tool_defs = capability_service.build_tool_definitions(capabilities)
        cap_prompts = [
            {"name": c.get("name", ""), "systemPrompt": c.get("systemPrompt", "")}
            for c in capabilities
            if c.get("systemPrompt")
        ]
        system_prompt = build_system_prompt(cap_prompts, timezone)

    # Pre-flight discovery
    if use_discovery:
        from clawbuddy.services.tool_discovery import tool_discovery_service

        enabled_slugs = [
            c.get("slug", "")
            for c in capabilities
            if c.get("slug") not in ALWAYS_ON_CAPABILITY_SLUGS
        ]
        preflight = await tool_discovery_service.search(
            str(safe_user_content),
            enabled_slugs,
            0.3,
        )
        if preflight:
            for cap in preflight:
                discovered_capabilities.append(cap)
                for tool in cap.tools:
                    if not any(t.get("name") == tool.get("name") for t in tool_defs):
                        tool_defs.append({
                            "name": tool["name"],
                            "description": tool["description"],
                            "parameters": tool.get("parameters", {}),
                        })
            cap_blocks = build_capability_blocks([
                {"name": c.name, "systemPrompt": c.instructions}
                for c in preflight
            ])
            system_prompt += f"\n\n{build_prompt_section('dynamically_loaded_capabilities', cap_blocks)}"

    # Remove delegation-only tools from main agent
    tool_defs = [t for t in tool_defs if t.get("name") not in DELEGATION_ONLY_TOOLS]

    # Inject document manifest
    doc_result = await db.execute(
        select(Document)
        .where(Document.workspace_id == workspace_id, Document.status == "READY")
        .order_by(Document.created_at.desc())
        .limit(MAX_AGENT_DOCUMENTS)
    )
    docs = doc_result.scalars().all()
    if docs:
        manifest = "\n".join(f"- {d.title} ({d.type})" for d in docs)
        system_prompt += f"\n\n{build_prompt_section('workspace_documents', f'The following {len(docs)} documents are available for search via search_documents:\n{manifest}')}"

    # Inject mentioned capability instructions
    if mentioned_slugs:
        mentioned_names = [
            next((c.get("name") for c in capabilities if c.get("slug") == slug), slug)
            for slug in mentioned_slugs
        ]
        if mentioned_names:
            system_prompt += f"\n\n{build_prompt_section('explicitly_requested_capabilities', f'The user explicitly requested the following capabilities: {', '.join(mentioned_names)}.\nYou MUST use the tools from these capabilities to fulfill this request. Do NOT substitute with other tools unless the requested tool fails or is clearly not applicable.')}"

    # Create LLM
    from clawbuddy.providers.llm_factory import create_chat_model

    llm = await create_chat_model(role="primary")

    # Initialize state
    state = AgentGraphState(
        session_id=session_id,
        workspace_id=workspace_id,
        emit=emit,
        abort_event=abort_event,
        secret_inventory=inventory,
        capabilities=capabilities,
        mentioned_slugs=mentioned_slugs or [],
        discovered_capability_slugs=[c.slug for c in discovered_capabilities],
        db=db,
    )

    # Context compression
    compression = await run_context_compression(state)

    # Build messages
    messages = _build_conversation_messages(
        system_prompt=system_prompt,
        summary=compression["summary"],
        recent_messages=compression["recent_messages"],
        current_user_content=str(safe_user_content),
        history_includes_current=history_includes_current_user_message,
    )

    # Sandbox setup
    from clawbuddy.services.tool_executor import tool_executor_service

    all_tool_names = [t.get("name", "") for t in tool_defs]
    needs_sandbox = use_discovery or tool_executor_service.needs_sandbox(all_tool_names)

    if needs_sandbox:
        if emit:
            await emit("thinking", {"message": "Starting sandbox environment..."})

        from clawbuddy.services.sandbox import sandbox_service

        needs_network = any(c.get("networkAccess") for c in capabilities)
        needs_docker = any(c.get("slug") == "docker" for c in capabilities)

        config_env = await capability_service.get_decrypted_capability_configs_for_workspace(
            db, workspace_id
        )
        merged_env: dict[str, str] = {}
        for env_map in config_env.values():
            merged_env.update(env_map)

        await sandbox_service.get_or_create_workspace_container(
            workspace_id,
            network_access=needs_network,
            docker_socket=needs_docker,
            env_vars=merged_env or None,
        )

        # Inject sandbox context
        secret_refs = sorted(set(
            ref.alias
            for ref in inventory.references
            if ref.transport == "env"
        ))
        sandbox_ctx = build_prompt_section(
            "sandbox_environment",
            "Username: root\n"
            "Working directory (cwd): /workspace/. All relative paths resolve here.\n"
            "Shared outputs: /workspace/.outputs/ (writable)\n"
            "When using sourcePath in generate_file, use the full path: "
            "/workspace/filename or /workspace/.outputs/filename"
            + (
                f"\nAvailable secret env references (values hidden): {', '.join(secret_refs)}"
                if inventory.enabled and secret_refs
                else ""
            ),
        )
        messages[0]["content"] += f"\n\n{sandbox_ctx}"

    # Load auto-approve rules
    global_result = await db.execute(
        select(GlobalSettings).where(GlobalSettings.id == "singleton")
    )
    global_settings = global_result.scalar_one_or_none()
    global_rules = (global_settings.auto_approve_rules or []) if global_settings else []

    session_result = await db.execute(
        select(ChatSession).where(ChatSession.id == session_id)
    )
    session_data = session_result.scalar_one_or_none()
    session_rules = (session_data.session_allow_rules or []) if session_data else []
    state.allow_rules = list(global_rules) + list(session_rules)

    # Main agent loop
    max_iterations = await settings_service.get_max_agent_iterations()
    accumulated_content = ""
    redacted_emit = (
        secret_redaction_service.create_redacted_emit(emit, inventory)
        if emit and inventory.enabled
        else emit
    )

    for i in range(max_iterations):
        if state.is_aborted:
            raise asyncio.CancelledError("Agent loop aborted by user")

        session_logger.debug_log(f"── Iteration {i + 1}/{max_iterations} ──")
        if emit:
            await emit("thinking", {"message": "Thinking..."})

        # Prune old tool results
        prune_old_tool_results(messages, i)

        # Invoke LLM
        from langchain_core.messages import (
            AIMessage,
            HumanMessage,
            SystemMessage,
            ToolMessage,
        )

        lc_messages = []
        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            if role == "system":
                lc_messages.append(SystemMessage(content=content))
            elif role == "user":
                lc_messages.append(HumanMessage(content=content))
            elif role == "assistant":
                tc = msg.get("toolCalls")
                if tc:
                    lc_messages.append(AIMessage(
                        content=content,
                        tool_calls=[
                            {"id": t["id"], "name": t["name"], "args": t.get("arguments", {})}
                            for t in tc
                        ],
                    ))
                else:
                    lc_messages.append(AIMessage(content=content))
            elif role == "tool":
                lc_messages.append(ToolMessage(
                    content=content,
                    tool_call_id=msg.get("toolCallId", ""),
                ))

        # Bind tools to model
        tool_schemas = [
            {
                "type": "function",
                "function": {
                    "name": t["name"],
                    "description": t["description"],
                    "parameters": t.get("parameters", {"type": "object", "properties": {}}),
                },
            }
            for t in tool_defs
        ]

        import time

        llm_start = time.monotonic()
        try:
            bound_llm = llm.bind_tools(tool_schemas) if tool_schemas else llm
            response = await bound_llm.ainvoke(lc_messages)
        except Exception as e:
            logger.error(f"[Agent] LLM call failed: {e}")
            raise

        llm_ms = int((time.monotonic() - llm_start) * 1000)

        # Extract response content and tool calls
        response_content = response.content or ""
        if isinstance(response_content, list):
            response_content = "".join(
                block.get("text", "") if isinstance(block, dict) else str(block)
                for block in response_content
            )

        response_tool_calls = getattr(response, "tool_calls", None) or []

        # Record token usage
        usage_meta = getattr(response, "usage_metadata", None)
        if usage_meta:
            usage = {
                "inputTokens": getattr(usage_meta, "input_tokens", 0),
                "outputTokens": getattr(usage_meta, "output_tokens", 0),
                "totalTokens": getattr(usage_meta, "total_tokens", 0),
            }
            provider_id = getattr(llm, "_provider_id", "unknown")
            model_id = getattr(llm, "model_name", "") or getattr(llm, "model", "unknown")
            await record_token_usage(usage, session_id, provider_id, model_id, db)

        # Redact response
        safe_content = secret_redaction_service.redact_for_public_storage(
            response_content, inventory
        )

        # No tool calls — done
        if not response_tool_calls:
            # Duplicate detection
            is_duplicate = (
                accumulated_content.strip()
                and safe_content.strip()
                and content_overlap_ratio(accumulated_content, safe_content) > 0.5
            )

            if not is_duplicate and emit:
                await emit("content", {"text": safe_content})

            final_content = (
                accumulated_content.strip()
                if is_duplicate
                else (accumulated_content + safe_content).strip()
            )

            # Save final message
            if not is_duplicate and safe_content.strip():
                sources_dicts = [
                    {
                        "documentId": s.document_id,
                        "documentTitle": s.document_title,
                        "chunkId": s.chunk_id,
                        "chunkIndex": s.chunk_index,
                    }
                    for s in state.sources
                ] if state.sources else None

                await save_assistant_message(
                    state, safe_content, sources=sources_dicts
                )

            return AgentResult(
                content=final_content,
                tool_executions=[
                    ToolExecution(
                        tool_name=te.tool_name,
                        capability_slug=te.capability_slug,
                        input=te.input,
                        output=te.output,
                        error=te.error,
                        exit_code=te.exit_code,
                        duration_ms=te.duration_ms,
                        sub_agent_execution_ids=te.sub_agent_execution_ids,
                    )
                    for te in state.tool_executions
                ],
                sources=[
                    DocumentSource(
                        document_id=s.document_id,
                        document_title=s.document_title,
                        chunk_id=s.chunk_id,
                        chunk_index=s.chunk_index,
                    )
                    for s in state.sources
                ] if state.sources else None,
                last_message_id=state.last_message_id,
            )

        # Emit intermediate content
        if safe_content.strip():
            if emit:
                await emit("content", {"text": safe_content})
            accumulated_content += safe_content + "\n\n"

        # Process tool calls
        tool_calls_for_msg = [
            {
                "id": tc["id"],
                "name": tc["name"],
                "arguments": secret_redaction_service.redact_for_public_storage(
                    tc.get("args", {}), inventory
                ),
            }
            for tc in response_tool_calls
        ]

        messages.append({
            "role": "assistant",
            "content": safe_content,
            "toolCalls": tool_calls_for_msg,
        })

        # Check each tool call
        tool_call_infos: list[ToolCallInfo] = []
        for tc in response_tool_calls:
            tc_id = tc.get("id", "")
            tc_name = tc.get("name", "")
            tc_args = tc.get("args", {})

            cap_slug = resolve_tool_capability(tc_name, capabilities) or "unknown"
            # Also check discovered capabilities
            if cap_slug == "unknown":
                for dc in discovered_capabilities:
                    for dt in dc.tools:
                        if dt.get("name") == tc_name:
                            cap_slug = dc.slug
                            break

            tc_info = ToolCallInfo(
                id=tc_id,
                name=tc_name,
                arguments=tc_args,
                capability_slug=cap_slug,
            )

            # Size guard check
            size_rejection = check_tool_arg_size(tc_name, tc_args)
            if size_rejection:
                messages.append({"role": "tool", "toolCallId": tc_id, "content": size_rejection})
                if emit:
                    await emit("tool_result", {
                        "toolCallId": tc_id,
                        "toolName": tc_name,
                        "error": size_rejection,
                        "durationMs": 0,
                    })
                continue

            # Discovery mode: reject undiscovered tools
            if use_discovery and not any(t.get("name") == tc_name for t in tool_defs):
                rejection = (
                    f'Tool "{tc_name}" is not yet available. Call discover_tools '
                    "first to find and load the appropriate tools for your task."
                )
                messages.append({"role": "tool", "toolCallId": tc_id, "content": rejection})
                if emit:
                    await emit("tool_result", {
                        "toolCallId": tc_id,
                        "toolName": tc_name,
                        "error": rejection,
                        "durationMs": 0,
                    })
                continue

            # Permission check
            is_allowed = await check_tool_approval(
                state, tc_info, auto_approve=auto_approve
            )
            if not is_allowed:
                # Pause for approval
                await save_agent_state_for_approval(
                    state,
                    pending_tool_calls=tool_calls_for_msg,
                    iteration=i,
                )
                return AgentResult(
                    content=accumulated_content.strip(),
                    paused=True,
                    tool_executions=[
                        ToolExecution(
                            tool_name=te.tool_name,
                            capability_slug=te.capability_slug,
                            input=te.input,
                            output=te.output,
                            error=te.error,
                            exit_code=te.exit_code,
                            duration_ms=te.duration_ms,
                        )
                        for te in state.tool_executions
                    ],
                    last_message_id=state.last_message_id,
                )

            tool_call_infos.append(tc_info)

        # Execute approved tool calls
        if tool_call_infos:
            # Emit tool_start events
            for tc_info in tool_call_infos:
                if emit:
                    public_args = secret_redaction_service.redact_for_public_storage(
                        tc_info.arguments, inventory
                    )
                    await emit("tool_start", {
                        "toolCallId": tc_info.id,
                        "toolName": tc_info.name,
                        "capabilitySlug": tc_info.capability_slug,
                        "input": public_args,
                    })

            results = await execute_tool_calls(state, tool_call_infos)

            # Add tool results to messages
            for result in results:
                content = build_tool_result_content(
                    result.content, error=result.error
                )
                messages.append({
                    "role": "tool",
                    "toolCallId": result.tool_call_id,
                    "content": content,
                })

            # Handle discovery results — add newly discovered tools
            for tc_info in tool_call_infos:
                if tc_info.name == "discover_tools":
                    # Find the result for this tool call
                    tc_result = next(
                        (r for r in results if r.tool_call_id == tc_info.id), None
                    )
                    if tc_result and tc_result.content:
                        import json

                        try:
                            parsed = json.loads(tc_result.content)
                            if isinstance(parsed, dict) and parsed.get("type") == "discovery_result":
                                for disc in parsed.get("discovered", []):
                                    for tool in disc.get("tools", []):
                                        if not any(t.get("name") == tool.get("name") for t in tool_defs):
                                            tool_defs.append(tool)
                                    discovered_capabilities.append(
                                        DiscoveredCapability(
                                            slug=disc.get("slug", ""),
                                            name=disc.get("name", ""),
                                            tools=disc.get("tools", []),
                                            instructions=disc.get("instructions", ""),
                                            network_access=False,
                                            skill_type=None,
                                        )
                                    )
                                    state.discovered_capability_slugs.append(disc.get("slug", ""))
                        except (json.JSONDecodeError, TypeError):
                            pass

    # Max iterations reached
    logger.warning(f"[Agent] Max iterations ({max_iterations}) reached for session {session_id}")

    if emit:
        await emit("content", {"text": "\n\n*[Maximum iterations reached]*"})

    return AgentResult(
        content=(accumulated_content + "\n\n*[Maximum iterations reached]*").strip(),
        tool_executions=[
            ToolExecution(
                tool_name=te.tool_name,
                capability_slug=te.capability_slug,
                input=te.input,
                output=te.output,
                error=te.error,
                exit_code=te.exit_code,
                duration_ms=te.duration_ms,
            )
            for te in state.tool_executions
        ],
        last_message_id=state.last_message_id,
    )


async def resume_agent_loop(
    session_id: str,
    emit: Callable[..., Awaitable[None]] | None = None,
    secret_inventory: SecretInventory | None = None,
    abort_event: asyncio.Event | None = None,
    db: AsyncSession | None = None,
) -> AgentResult:
    """Resume agent loop after tool approval decisions.

    Deserializes saved agent state, executes approved tool calls,
    then continues the agent loop from where it paused.
    """
    from clawbuddy.db.models import ToolApproval, Workspace
    from clawbuddy.graph.nodes.result_processing import prepare_tool_result_for_sse
    from clawbuddy.services.agent_state import deserialize_agent_state
    from clawbuddy.services.tool_executor import ExecutionContext, tool_executor_service

    if db is None:
        from clawbuddy.db.session import async_session_factory
        async with async_session_factory() as db:
            return await resume_agent_loop(
                session_id, emit, secret_inventory, abort_event, db
            )

    session_result = await db.execute(
        select(ChatSession).where(ChatSession.id == session_id)
    )
    session = session_result.scalar_one()
    workspace_id = session.workspace_id

    inventory = secret_inventory or await secret_redaction_service.build_secret_inventory(
        db, workspace_id
    )
    session_logger = create_session_logger(session_id, inventory)
    session_logger.debug_log("resumeAgentLoop START", {"sessionId": session_id})

    # Deserialize saved state
    saved_state = deserialize_agent_state(
        getattr(session, "agent_state", None),
        getattr(session, "agent_state_encrypted", None),
    )
    if not saved_state:
        raise RuntimeError("No agent state to resume")

    # Get all decided approvals
    approval_result = await db.execute(
        select(ToolApproval)
        .where(ToolApproval.chat_session_id == session_id)
        .order_by(ToolApproval.created_at.asc())
    )
    approvals = list(approval_result.scalars().all())

    pending_approvals = [a for a in approvals if a.status == "pending"]
    if pending_approvals:
        raise RuntimeError("Not all approvals have been decided")

    # Clear agent state
    session.agent_state = None
    session.agent_state_encrypted = None
    session.agent_status = "running"
    await db.commit()

    messages = saved_state.messages
    tool_execution_log = saved_state.tool_execution_log or []
    pending_tool_calls = saved_state.pending_tool_calls or []
    iteration = saved_state.iteration or 0
    last_saved_message_id: str | None = None

    # Check if any tool was denied — if so, stop immediately
    has_denied = any(
        any(
            a.tool_call_id == tc.get("id") and a.status == "denied"
            for a in approvals
        )
        for tc in pending_tool_calls
    )

    if has_denied:
        denied_names = [
            tc.get("name", "")
            for tc in pending_tool_calls
            if any(
                a.tool_call_id == tc.get("id") and a.status == "denied"
                for a in approvals
            )
        ]

        from sqlalchemy import delete as sa_delete
        await db.execute(
            sa_delete(ToolApproval).where(ToolApproval.chat_session_id == session_id)
        )
        session.agent_status = "idle"
        await db.commit()

        rejection_content = f"Action skipped — {', '.join(denied_names)} was not approved."
        if emit:
            await emit("content", {"text": rejection_content})

        try:
            denied_msg = ChatMessage(
                session_id=session_id,
                role="assistant",
                content=strip_null_bytes(rejection_content),
            )
            db.add(denied_msg)
            await db.commit()
            await db.refresh(denied_msg)
            last_saved_message_id = denied_msg.id
        except Exception:
            pass

        return AgentResult(
            content=rejection_content,
            last_message_id=last_saved_message_id,
        )

    # Pre-load capabilities for resume execution
    capabilities = await capability_service.get_enabled_capabilities_for_workspace(
        db, workspace_id
    )

    # Process approved tool calls
    resume_execution_ids: list[str] = []

    ctx = ExecutionContext(
        workspace_id=workspace_id,
        chat_session_id=session_id,
        db=db,
        secret_inventory=inventory,
        emit=emit,
        capabilities=capabilities,
        abort_event=abort_event,
    )

    from clawbuddy.constants import PARALLEL_SAFE_TOOLS

    for tc in pending_tool_calls:
        tc_name = tc.get("name", "")
        tc_id = tc.get("id", "")
        tc_args = tc.get("arguments", {})

        cap_slug = resolve_tool_capability(tc_name, capabilities) or "unknown"
        if cap_slug == "unknown":
            matching_approval = next(
                (a for a in approvals if a.tool_call_id == tc_id), None
            )
            if matching_approval:
                cap_slug = matching_approval.capability_slug or "unknown"

        public_args = secret_redaction_service.redact_for_public_storage(
            tc_args, inventory
        )

        is_discovery = tc_name == "discover_tools"
        if is_discovery:
            if emit:
                await emit("thinking", {"message": "Looking for the right tools..."})
        else:
            if emit:
                await emit("tool_start", {
                    "toolCallId": tc_id,
                    "toolName": tc_name,
                    "capabilitySlug": cap_slug,
                    "input": public_args,
                })

        result = await tool_executor_service.execute(
            tool_name=tc_name,
            tool_call_id=tc_id,
            arguments=tc_args,
            capability_slug=cap_slug,
            ctx=ctx,
        )

        if not is_discovery and emit:
            sse_payload = prepare_tool_result_for_sse(
                result.output or "",
                tool_name=tc_name,
            )
            await emit("tool_result", {
                "toolCallId": tc_id,
                "toolName": tc_name,
                **sse_payload,
                "error": result.error,
                "exitCode": result.exit_code,
                "durationMs": result.duration_ms,
            })

        if result.execution_id:
            resume_execution_ids.append(result.execution_id)

        # Add tool result to messages
        raw_content = (
            result.output
            if tc_name == "run_browser_script"
            else (
                f"Error: {result.error}\n\n{result.output}"
                if result.error
                else result.output
            )
        )
        tool_content = maybe_truncate_output(raw_content or "")
        messages.append({
            "role": "tool",
            "toolCallId": tc_id,
            "content": tool_content or "No output",
        })

        tool_execution_log.append({
            "toolName": tc_name,
            "capabilitySlug": cap_slug,
            "input": public_args,
            "output": (result.output or "")[:2000],
            "error": result.error,
            "exitCode": result.exit_code,
            "durationMs": result.duration_ms,
        })

    # Save the approved tool calls as a ChatMessage
    if pending_tool_calls:
        try:
            from clawbuddy.db.models import ToolExecution as ToolExecutionModel

            approved_tool_calls = [
                {
                    "name": tc.get("name"),
                    "capability": next(
                        (a.capability_slug for a in approvals if a.tool_call_id == tc.get("id")),
                        "unknown",
                    ),
                    "input": secret_redaction_service.redact_for_public_storage(
                        tc.get("arguments", {}), inventory
                    ),
                }
                for tc in pending_tool_calls
            ]
            content_blocks = [
                (
                    {
                        "type": "sub_agent",
                        "toolIndex": idx,
                        "subAgentId": tc.get("id"),
                        "role": str(tc.get("arguments", {}).get("role", "execute")),
                        "task": str(tc.get("arguments", {}).get("task", "")),
                    }
                    if tc.get("name") == "delegate_task"
                    else {"type": "tool", "toolIndex": idx}
                )
                for idx, tc in enumerate(pending_tool_calls)
            ]

            approved_msg = ChatMessage(
                session_id=session_id,
                role="assistant",
                content="",
                tool_calls=approved_tool_calls,
                content_blocks=content_blocks,
            )
            db.add(approved_msg)
            await db.commit()
            await db.refresh(approved_msg)
            last_saved_message_id = approved_msg.id

            if resume_execution_ids:
                from sqlalchemy import update as sa_update
                await db.execute(
                    sa_update(ToolExecutionModel)
                    .where(ToolExecutionModel.id.in_(resume_execution_ids))
                    .values(chat_message_id=approved_msg.id)
                )
                await db.commit()
        except Exception as exc:
            logger.error(f"[Agent] Failed to save approved tools message: {exc}")

    # Clean up approvals
    from sqlalchemy import delete as sa_delete
    await db.execute(
        sa_delete(ToolApproval).where(ToolApproval.chat_session_id == session_id)
    )
    await db.commit()

    # Continue the agent loop from where we left off
    ws_result = await db.execute(
        select(Workspace.auto_execute).where(Workspace.id == workspace_id)
    )
    auto_execute = ws_result.scalar() or False

    result = await run_agent_loop(
        session_id=session_id,
        user_content="",  # No new user content, continuing from saved messages
        workspace_id=workspace_id,
        emit=emit,
        db=db,
        auto_approve=auto_execute,
        mentioned_slugs=saved_state.mentioned_slugs,
        secret_inventory=inventory,
        history_includes_current_user_message=True,
        abort_event=abort_event,
    )

    if not result.paused:
        session.agent_status = "idle"
        await db.commit()

    return AgentResult(
        content=result.content,
        paused=result.paused,
        tool_executions=result.tool_executions,
        sources=result.sources,
        message_id=result.message_id,
        last_message_id=result.last_message_id or last_saved_message_id,
    )
