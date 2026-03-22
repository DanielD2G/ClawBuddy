"""Provider state — aggregate provider info for the frontend.

Replaces: apps/api/src/services/provider-state.service.ts
"""

from __future__ import annotations

from typing import Any

from clawbuddy.lib.llm_resolver import build_resolved_role_providers
from clawbuddy.services.model_discovery import build_model_catalogs
from clawbuddy.services.settings_service import settings_service


async def build_provider_state() -> dict[str, Any]:
    """Build the full provider state object for the frontend."""
    s = await settings_service.get()
    available = await settings_service.get_available_providers()
    models = await build_model_catalogs(available)

    return {
        "metadata": settings_service.get_provider_metadata(),
        "connections": await settings_service.get_provider_connections(),
        "active": {
            "llm": s["aiProvider"],
            "llmModel": s.get("aiModel"),
            "mediumModel": s.get("mediumModel"),
            "lightModel": s.get("lightModel"),
            "exploreModel": s.get("exploreModel"),
            "executeModel": s.get("executeModel"),
            "titleModel": s.get("titleModel"),
            "compactModel": s.get("compactModel"),
            "advancedModelConfig": s.get("advancedModelConfig"),
            "roleProviders": build_resolved_role_providers(s),
            "embedding": s["embeddingProvider"],
            "embeddingModel": s.get("embeddingModel"),
            "localBaseUrl": s.get("localBaseUrl"),
        },
        "available": available,
        "models": models,
    }
