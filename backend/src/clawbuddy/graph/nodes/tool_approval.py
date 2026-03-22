"""Tool approval node — checks permissions and requests approval if needed.

Replaces: Permission checking logic from agent.service.ts
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from clawbuddy.db.models import ToolApproval
from clawbuddy.graph.state import AgentGraphState, ToolCallInfo
from clawbuddy.services.permission import permission_service
from clawbuddy.services.secret_redaction import secret_redaction_service


async def check_tool_approval(
    state: AgentGraphState,
    tool_call: ToolCallInfo,
    *,
    auto_approve: bool = False,
) -> bool:
    """Check if a tool call is allowed or needs approval.

    Returns True if allowed (proceed with execution), False if approval is
    needed (agent should pause).
    """
    is_allowed = permission_service.is_tool_allowed(
        tool_call.name, tool_call.arguments, state.allow_rules
    )

    if is_allowed or auto_approve:
        return True

    # Create approval record and emit SSE
    db: AsyncSession = state.db
    inventory = state.secret_inventory

    public_input = (
        secret_redaction_service.redact_for_public_storage(
            tool_call.arguments, inventory
        )
        if inventory
        else tool_call.arguments
    )

    approval = ToolApproval(
        chat_session_id=state.session_id,
        tool_name=tool_call.name,
        capability_slug=tool_call.capability_slug,
        input=public_input,
        tool_call_id=tool_call.id,
    )
    db.add(approval)
    await db.flush()

    # Emit approval_required event
    if state.emit:
        approval_data: dict[str, Any] = {
            "approvalId": approval.id,
            "toolName": tool_call.name,
            "capabilitySlug": tool_call.capability_slug,
            "input": public_input,
        }

        # Add sub-agent metadata for delegate_task
        if tool_call.name == "delegate_task":
            role = tool_call.arguments.get("role", "")
            approval_data.update({
                "subAgentRole": role,
                "subAgentDescription": _get_role_description(role),
            })

        await state.emit("approval_required", approval_data)

    return False


def _get_role_description(role: str) -> str:
    """Get description for a sub-agent role."""
    descriptions = {
        "explore": "Fast read-only agent for searching, reading files, web browsing",
        "analyze": "Read-only agent for data analysis with Python and document search",
        "execute": "Full-capability agent for complex multi-step tasks",
    }
    return descriptions.get(role, "Unknown role")
