"""Chat router — SSE streaming, sessions, approvals, file uploads.

Replaces: apps/api/src/routes/chat.ts
"""

from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy import select, text, update
from sqlalchemy.exc import NoResultFound
from sqlalchemy.ext.asyncio import AsyncSession

from clawbuddy.constants import MAX_FILE_UPLOAD_BYTES
from clawbuddy.db.models import (
    ChatMessage,
    ChatSession,
    GlobalSettings,
    ToolApproval,
)
from clawbuddy.db.session import get_db
from clawbuddy.lib.agent_abort import agent_loops
from clawbuddy.lib.responses import fail, ok
from clawbuddy.lib.sanitize import sanitize_file_name
from clawbuddy.lib.sse import create_sse_stream
from clawbuddy.schemas.chat import (
    CreateChatSessionInput,
    SendChatMessageInput,
)
from clawbuddy.services.chat import chat_service
from clawbuddy.services.mention_parser import mention_parser_service
from clawbuddy.services.secret_redaction import secret_redaction_service

router = APIRouter(tags=["chat"])


# ── Send chat message (SSE) ─────────────────────────────────


@router.post("/chat")
async def send_chat_message(
    body: SendChatMessageInput,
    db: AsyncSession = Depends(get_db),
):
    """Send a chat message. Returns SSE stream with agent/RAG responses."""
    session_id = body.session_id
    workspace_id = body.workspace_id

    if not session_id:
        if not workspace_id:
            raise HTTPException(
                status_code=400,
                detail="workspaceId is required for new sessions",
            )
        try:
            session = await chat_service.create_session(
                db, workspace_id=workspace_id
            )
        except NoResultFound:
            return fail("Workspace not found", status_code=404)
        session_id = session.id
    elif not workspace_id:
        session = await chat_service.get_session(db, session_id)
        workspace_id = session.workspace_id if session else None

    # Parse mentions
    parsed = mention_parser_service.parse(body.content)
    cleaned_content = parsed.cleaned_content
    mentioned_slugs = parsed.mentioned_slugs

    current_session_id = session_id
    attachments = (
        [a.model_dump(by_alias=True) for a in body.attachments]
        if body.attachments
        else None
    )

    inventory = await secret_redaction_service.build_secret_inventory(
        db, workspace_id
    )

    async def handler(emit):
        redacted_emit = secret_redaction_service.create_redacted_emit(
            emit, inventory
        )
        await redacted_emit("session", {"sessionId": current_session_id})
        await chat_service.send_message(
            db,
            current_session_id,
            body.content,
            redacted_emit,
            document_ids=(
                body.document_ids if body.document_ids else None
            ),
            mentioned_slugs=mentioned_slugs,
            attachments=attachments,
            inventory=inventory,
            llm_content=cleaned_content or None,
        )

    return create_sse_stream(handler)


# ── Approve/deny tool call ───────────────────────────────────


@router.post("/chat/sessions/{session_id}/approve")
async def approve_tool_call(
    session_id: str,
    body: dict[str, Any],
    db: AsyncSession = Depends(get_db),
):
    """Approve or deny a pending tool call."""
    approval_id = body.get("approvalId")
    decision = body.get("decision")
    allow_rule = body.get("allowRule")
    scope = body.get("scope")

    if not approval_id or decision not in ("approved", "denied"):
        return fail(
            "approvalId and decision (approved/denied) are required",
            status_code=400,
        )

    session = await chat_service.get_session(db, session_id)
    if not session:
        return fail("Session not found", status_code=404)

    # Update approval status
    result = await db.execute(
        select(ToolApproval).where(ToolApproval.id == approval_id)
    )
    approval = result.scalar_one_or_none()
    if approval:
        approval.status = decision
        approval.decided_at = datetime.now(timezone.utc)
        await db.commit()

    # Save allow rule if provided
    if decision == "approved" and allow_rule and scope:
        if scope == "global":
            gs_result = await db.execute(
                select(GlobalSettings).where(GlobalSettings.id == "singleton")
            )
            gs = gs_result.scalar_one_or_none()
            existing_rules: list[str] = (
                gs.auto_approve_rules if gs and gs.auto_approve_rules else []
            )
            if allow_rule not in existing_rules:
                new_rules = [*existing_rules, allow_rule]
                if gs:
                    gs.auto_approve_rules = new_rules
                else:
                    gs = GlobalSettings(
                        id="singleton", auto_approve_rules=new_rules
                    )
                    db.add(gs)
                await db.commit()
        elif scope == "session":
            existing_rules = session.session_allow_rules or []
            if allow_rule not in existing_rules:
                session.session_allow_rules = [*existing_rules, allow_rule]
                await db.commit()

    # Check if there are more pending approvals
    pending_result = await db.execute(
        select(ToolApproval).where(
            ToolApproval.chat_session_id == session_id,
            ToolApproval.status == "pending",
        )
    )
    pending = pending_result.scalars().all()

    if pending:
        return ok({"status": "waiting", "pendingCount": len(pending)})

    # Resume agent loop via SSE
    from clawbuddy.graph.agent_graph import resume_agent_loop

    inventory = await secret_redaction_service.build_secret_inventory(
        db, session.workspace_id
    )
    abort_event = agent_loops.register(session_id)

    async def handler(emit):
        try:
            redacted_emit = secret_redaction_service.create_redacted_emit(
                emit, inventory
            )
            result = await resume_agent_loop(
                session_id=session_id,
                emit=redacted_emit,
                secret_inventory=inventory,
                abort_event=abort_event,
                db=db,
            )

            if not result.paused:
                await redacted_emit("done", {
                    "messageId": result.last_message_id,
                    "sessionId": session_id,
                })

            # Generate title if missing
            session_data = await chat_service.get_session(db, session_id)
            if session_data and not session_data.title:
                first_msg_result = await db.execute(
                    select(ChatMessage)
                    .where(
                        ChatMessage.session_id == session_id,
                        ChatMessage.role == "user",
                    )
                    .order_by(ChatMessage.created_at.asc())
                    .limit(1)
                )
                first_msg = first_msg_result.scalar_one_or_none()
                if first_msg:
                    await chat_service._auto_title(
                        session_id, first_msg.content
                    )
        except Exception as exc:
            if abort_event.is_set():
                try:
                    session_obj = await chat_service.get_session(
                        db, session_id
                    )
                    if session_obj:
                        session_obj.agent_status = "idle"
                        session_obj.agent_state_encrypted = None
                        await db.commit()
                except Exception:
                    pass
                await emit("aborted", {"sessionId": session_id})
                await emit("done", {"sessionId": session_id})
                return
            raise
        finally:
            agent_loops.unregister(session_id)

    return create_sse_stream(handler)


# ── Abort agent loop ─────────────────────────────────────────


@router.post("/chat/sessions/{session_id}/abort")
async def abort_agent(
    session_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Abort a running agent loop."""
    agent_loops.abort(session_id)

    # Reset session status and deny pending approvals
    try:
        result = await db.execute(
            select(ChatSession).where(ChatSession.id == session_id)
        )
        session = result.scalar_one_or_none()
        if session:
            session.agent_status = "idle"
            session.agent_state_encrypted = None
    except Exception:
        pass

    try:
        await db.execute(
            update(ToolApproval)
            .where(
                ToolApproval.chat_session_id == session_id,
                ToolApproval.status == "pending",
            )
            .values(
                status="denied",
                decided_at=datetime.now(timezone.utc),
            )
        )
    except Exception:
        pass

    await db.commit()
    return ok(None)


# ── File upload ──────────────────────────────────────────────


@router.post("/chat/upload")
async def upload_chat_attachment(
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
):
    """Upload a file for chat attachment."""
    if not file.filename:
        return fail("No file provided", status_code=400)

    # Check file size
    content = await file.read()
    if len(content) > MAX_FILE_UPLOAD_BYTES:
        return fail("File too large (max 20MB)", status_code=400)

    from clawbuddy.services.storage import storage_service

    key = f"chat-attachments/{int(time.time() * 1000)}-{sanitize_file_name(file.filename)}"
    await storage_service.upload(
        key, content, file.content_type or "application/octet-stream"
    )

    return ok({
        "name": file.filename,
        "size": len(content),
        "type": file.content_type or "application/octet-stream",
        "storageKey": key,
        "url": f"/api/files/{key}",
    })


# ── Session CRUD ─────────────────────────────────────────────


@router.get("/chat/sessions")
async def list_sessions(db: AsyncSession = Depends(get_db)):
    """List all chat sessions."""
    sessions = await chat_service.list_sessions(db)
    return ok(sessions)


@router.post("/chat/sessions", status_code=201)
async def create_session(
    body: CreateChatSessionInput,
    db: AsyncSession = Depends(get_db),
):
    """Create a new chat session."""
    try:
        session = await chat_service.create_session(
            db, workspace_id=body.workspace_id, title=body.title
        )
    except NoResultFound:
        return fail("Workspace not found", status_code=404)
    return ok({
        "id": session.id,
        "workspaceId": session.workspace_id,
        "title": session.title,
        "createdAt": session.created_at.isoformat() if session.created_at else None,
    })


@router.delete("/chat/sessions/{session_id}")
async def delete_session(
    session_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Delete a chat session."""
    await chat_service.delete_session(db, session_id)
    return ok({"id": session_id})


@router.get("/chat/sessions/{session_id}/messages")
async def get_messages(
    session_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Get all messages for a session."""
    session_result = await db.execute(
        select(ChatSession.agent_status).where(ChatSession.id == session_id)
    )
    agent_status = session_result.scalar() or "idle"

    messages = await chat_service.get_messages(db, session_id)

    # Include pending approval state so the UI can restore after reload
    pending_approvals: list[dict[str, Any]] = []
    if agent_status == "awaiting_approval":
        pa_result = await db.execute(
            select(ToolApproval).where(
                ToolApproval.chat_session_id == session_id,
                ToolApproval.status == "pending",
            )
        )
        pending_approvals = [
            {
                "id": pa.id,
                "toolName": pa.tool_name,
                "capabilitySlug": pa.capability_slug,
                "input": pa.input,
            }
            for pa in pa_result.scalars().all()
        ]

    return ok({
        "messages": messages,
        "agentStatus": agent_status,
        "pendingApprovals": pending_approvals,
    })


@router.post("/chat/sessions/{session_id}/read")
async def mark_session_read(
    session_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Mark a session as read."""
    await chat_service.mark_as_read(db, session_id)
    return ok(None)
