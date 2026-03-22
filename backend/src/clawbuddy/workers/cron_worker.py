"""Cron worker — ARQ background task for executing scheduled jobs.

Replaces: apps/api/src/workers/cron.worker.ts (BullMQ)

Handles two types of cron jobs:
- internal: Runs a named handler function (e.g. cleanup idle containers)
- agent: Runs the agent loop with a prompt and optional Telegram forwarding
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from loguru import logger

from clawbuddy.workers.cron_handlers import CRON_HANDLERS


async def execute_cron_job(
    ctx: dict[str, Any],
    cron_job_id: str,
) -> None:
    """ARQ task: execute a scheduled cron job."""
    from clawbuddy.db.models import ChatMessage, ChatSession, CronJob, Workspace
    from clawbuddy.db.session import async_session_factory
    from sqlalchemy import select

    async with async_session_factory() as db:
        result = await db.execute(
            select(CronJob).where(CronJob.id == cron_job_id)
        )
        cron_job = result.scalar_one_or_none()

        if not cron_job:
            logger.warning(
                f"[Cron] Job {cron_job_id} not found in DB, skipping"
            )
            return

        if not cron_job.enabled:
            return

        logger.info(f'[Cron] Executing "{cron_job.name}" ({cron_job.type})')

        try:
            if cron_job.type == "internal":
                handler = CRON_HANDLERS.get(cron_job.handler) if cron_job.handler else None
                if not handler:
                    raise RuntimeError(f"Unknown handler: {cron_job.handler}")
                await handler()

            elif cron_job.type == "agent":
                if not cron_job.prompt:
                    raise RuntimeError("Agent cron job has no prompt")

                workspace_id = cron_job.workspace_id
                if not workspace_id:
                    ws_result = await db.execute(
                        select(Workspace)
                        .order_by(Workspace.created_at.asc())
                        .limit(1)
                    )
                    fallback_ws = ws_result.scalar_one_or_none()
                    if not fallback_ws:
                        raise RuntimeError(
                            "Agent cron job has no workspaceId and no "
                            "workspaces exist"
                        )
                    workspace_id = fallback_ws.id

                # Use the session from the originating chat, or create one
                session_id = cron_job.session_id
                if not session_id:
                    session = ChatSession(
                        workspace_id=workspace_id,
                        title=f"[Cron] {cron_job.name}",
                    )
                    db.add(session)
                    await db.commit()
                    await db.refresh(session)
                    session_id = session.id
                    cron_job.session_id = session_id
                    await db.commit()

                # Save the cron prompt as a user message
                user_msg = ChatMessage(
                    session_id=session_id,
                    role="user",
                    content=f"[Cron: {cron_job.name}] {cron_job.prompt}",
                )
                db.add(user_msg)
                await db.commit()

                # If session is linked to Telegram, forward responses there
                from typing import Callable, Awaitable

                cron_emit: Callable[..., Awaitable[None]] | None = None
                session_result = await db.execute(
                    select(ChatSession).where(ChatSession.id == session_id)
                )
                cron_session = session_result.scalar_one_or_none()

                if (
                    cron_session
                    and cron_session.source == "telegram"
                    and cron_session.external_chat_id
                    and cron_session.workspace_id
                ):
                    try:
                        from clawbuddy.channels.telegram.emit import (
                            create_telegram_emit,
                        )

                        cron_emit = create_telegram_emit(
                            cron_session.workspace_id,
                            cron_session.external_chat_id,
                        )
                    except ImportError:
                        pass

                # Run agent loop (auto-approve since no user to decide)
                from clawbuddy.graph.agent_graph import run_agent_loop

                try:
                    await run_agent_loop(
                        session_id=session_id,
                        user_content=cron_job.prompt,
                        workspace_id=workspace_id,
                        emit=cron_emit,
                        db=db,
                        auto_approve=True,
                        history_includes_current_user_message=True,
                    )
                except Exception as agent_err:
                    # Save error as assistant message
                    error_msg = ChatMessage(
                        session_id=session_id,
                        role="assistant",
                        content=f"Cron execution failed: {agent_err}",
                    )
                    db.add(error_msg)
                    await db.commit()
                    raise

            # Update last run status
            cron_job.last_run_at = datetime.now(timezone.utc)
            cron_job.last_run_status = "success"
            cron_job.last_run_error = None
            await db.commit()

            logger.info(f'[Cron] "{cron_job.name}" completed successfully')

        except Exception as exc:
            error_msg = str(exc)
            logger.error(f'[Cron] "{cron_job.name}" failed: {error_msg}')

            cron_job.last_run_at = datetime.now(timezone.utc)
            cron_job.last_run_status = "error"
            cron_job.last_run_error = error_msg
            await db.commit()
