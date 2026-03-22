"""Settings routes.

Replaces: apps/api/src/routes/settings.ts
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from clawbuddy.db.models import TokenUsage
from clawbuddy.db.session import get_db
from clawbuddy.lib.responses import ok
from clawbuddy.services.settings_service import settings_service

router = APIRouter(tags=["Settings"])


@router.get("/settings/providers")
async def get_providers() -> dict[str, Any]:
    from clawbuddy.services.provider_state import build_provider_state

    return ok(await build_provider_state())


@router.get("/settings/models")
async def get_models() -> dict[str, Any]:
    from clawbuddy.services.model_discovery import discover_llm_models

    provider = await settings_service.get_ai_provider()
    primary = await settings_service.get_ai_model()
    medium = await settings_service.get_medium_model()
    light = await settings_service.get_light_model()
    explore = await settings_service.get_explore_model()
    execute = await settings_service.get_execute_model()
    title = await settings_service.get_title_model()
    compact = await settings_service.get_compact_model()
    embedding_model = await settings_service.get_embedding_model()
    advanced_model_config = await settings_service.get_advanced_model_config()
    context_limit = await settings_service.get_context_limit_tokens()
    max_iterations = await settings_service.get_max_agent_iterations()
    sub_explore = await settings_service.get_sub_agent_explore_max_iterations()
    sub_analyze = await settings_service.get_sub_agent_analyze_max_iterations()
    sub_execute = await settings_service.get_sub_agent_execute_max_iterations()
    available = await settings_service.get_available_providers()
    role_providers = await settings_service.get_resolved_role_providers()
    tz = await settings_service.get_timezone()

    # Build per-provider catalogs
    catalogs: dict[str, list[str]] = {}
    for p in available["llm"]:
        catalogs[p] = await discover_llm_models(p)

    return ok(
        {
            "provider": provider,
            "models": {
                "primary": primary,
                "medium": medium,
                "light": light,
                "explore": explore,
                "execute": execute,
                "title": title,
                "compact": compact,
            },
            "roleProviders": role_providers,
            "embeddingModel": embedding_model,
            "advancedModelConfig": advanced_model_config,
            "contextLimitTokens": context_limit,
            "maxAgentIterations": max_iterations,
            "subAgentExploreMaxIterations": sub_explore,
            "subAgentAnalyzeMaxIterations": sub_analyze,
            "subAgentExecuteMaxIterations": sub_execute,
            "availableProviders": available["llm"],
            "catalogs": catalogs,
            "timezone": tz,
        }
    )


@router.patch("/settings/models")
async def update_models(body: dict[str, Any]) -> dict[str, Any]:
    update_data: dict[str, Any] = {}
    field_map = {
        "provider": "aiProvider",
        "primary": "aiModel",
        "medium": "mediumModel",
        "light": "lightModel",
        "explore": "exploreModel",
        "execute": "executeModel",
        "title": "titleModel",
        "compact": "compactModel",
        "roleProviders": "roleProviders",
        "advancedModelConfig": "advancedModelConfig",
        "contextLimitTokens": "contextLimitTokens",
        "maxAgentIterations": "maxAgentIterations",
        "subAgentExploreMaxIterations": "subAgentExploreMaxIterations",
        "subAgentAnalyzeMaxIterations": "subAgentAnalyzeMaxIterations",
        "subAgentExecuteMaxIterations": "subAgentExecuteMaxIterations",
        "timezone": "timezone",
    }
    for body_key, data_key in field_map.items():
        if body_key in body:
            update_data[data_key] = body[body_key]

    await settings_service.update(update_data)
    return ok(None)


# ── Token usage stats ──────────────────────────────────────

@router.get("/settings/token-usage")
async def get_token_usage(db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    # Totals
    totals_result = await db.execute(
        select(
            func.sum(TokenUsage.input_tokens).label("input"),
            func.sum(TokenUsage.output_tokens).label("output"),
            func.sum(TokenUsage.total_tokens).label("total"),
            func.count().label("count"),
        )
    )
    totals = totals_result.one()

    # Per provider
    by_provider_result = await db.execute(
        select(
            TokenUsage.provider,
            func.sum(TokenUsage.input_tokens).label("input"),
            func.sum(TokenUsage.output_tokens).label("output"),
            func.sum(TokenUsage.total_tokens).label("total"),
        ).group_by(TokenUsage.provider)
    )

    # Per model
    by_model_result = await db.execute(
        select(
            TokenUsage.model,
            func.sum(TokenUsage.input_tokens).label("input"),
            func.sum(TokenUsage.output_tokens).label("output"),
            func.sum(TokenUsage.total_tokens).label("total"),
        ).group_by(TokenUsage.model)
    )

    # Last 7 days
    seven_days_ago = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%d")
    daily_result = await db.execute(
        select(
            TokenUsage.date,
            func.sum(TokenUsage.input_tokens).label("input"),
            func.sum(TokenUsage.output_tokens).label("output"),
            func.sum(TokenUsage.total_tokens).label("total"),
        )
        .where(TokenUsage.date >= seven_days_ago)
        .group_by(TokenUsage.date)
        .order_by(TokenUsage.date.asc())
    )

    return ok(
        {
            "totals": {
                "inputTokens": totals.input or 0,
                "outputTokens": totals.output or 0,
                "totalTokens": totals.total or 0,
                "requests": totals.count or 0,
            },
            "byProvider": [
                {
                    "provider": row.provider,
                    "inputTokens": row.input or 0,
                    "outputTokens": row.output or 0,
                    "totalTokens": row.total or 0,
                }
                for row in by_provider_result.all()
            ],
            "byModel": [
                {
                    "model": row.model,
                    "inputTokens": row.input or 0,
                    "outputTokens": row.output or 0,
                    "totalTokens": row.total or 0,
                }
                for row in by_model_result.all()
            ],
            "daily": [
                {
                    "date": row.date,
                    "inputTokens": row.input or 0,
                    "outputTokens": row.output or 0,
                    "totalTokens": row.total or 0,
                }
                for row in daily_result.all()
            ],
        }
    )


@router.delete("/settings/token-usage")
async def reset_token_usage(db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    await db.execute(delete(TokenUsage))
    await db.commit()
    return ok(None)
