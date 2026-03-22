"""LLM role resolution — maps roles to provider+model pairs.

Replaces: apps/api/src/lib/llm-resolver.ts
"""

from __future__ import annotations

from typing import Any, Literal, TypedDict

# ── Role → settings field mapping ────────────────────────────
LLM_ROLE_MODEL_FIELDS: dict[str, str] = {
    "primary": "aiModel",
    "medium": "mediumModel",
    "light": "lightModel",
    "explore": "exploreModel",
    "execute": "executeModel",
    "title": "titleModel",
    "compact": "compactModel",
}

LLMRole = Literal["primary", "medium", "light", "explore", "execute", "title", "compact"]
SecondaryLLMRole = Literal["medium", "light", "explore", "execute", "title", "compact"]

SECONDARY_LLM_ROLES: tuple[SecondaryLLMRole, ...] = (
    "medium",
    "light",
    "explore",
    "execute",
    "title",
    "compact",
)

LLMProviderOverrides = dict[SecondaryLLMRole, str]


class ResolvedLLMRole(TypedDict):
    provider: str
    model: str | None


ResolvedLLMRoleMap = dict[LLMRole, ResolvedLLMRole]
ResolvedRoleProviderMap = dict[LLMRole, str]


class LLMSettings(TypedDict, total=False):
    """Minimal interface for settings used by the resolver."""

    aiProvider: str
    aiModel: str | None
    mediumModel: str | None
    lightModel: str | None
    exploreModel: str | None
    executeModel: str | None
    titleModel: str | None
    compactModel: str | None
    advancedModelConfig: bool
    llmProviderOverrides: Any


def normalize_llm_provider_overrides(value: Any) -> LLMProviderOverrides:
    """Normalize an arbitrary value into a valid provider overrides dict."""
    if not value or not isinstance(value, dict):
        return {}

    normalized: LLMProviderOverrides = {}
    for role in SECONDARY_LLM_ROLES:
        provider = value.get(role)
        if isinstance(provider, str) and provider.strip():
            normalized[role] = provider.strip()
    return normalized


def merge_llm_provider_overrides(
    current: Any,
    updates: dict[str, str] | None = None,
) -> LLMProviderOverrides:
    """Merge existing overrides with new updates."""
    merged = normalize_llm_provider_overrides(current)
    if not updates:
        return merged

    for role in SECONDARY_LLM_ROLES:
        provider = updates.get(role)
        if isinstance(provider, str) and provider.strip():
            merged[role] = provider.strip()

    return merged


def resolve_llm_role(
    llm_settings: LLMSettings,
    role: LLMRole,
) -> ResolvedLLMRole:
    """Resolve a single LLM role to its provider + model pair.

    Falls back to the primary provider/model when the role has no specific model set.
    """
    overrides = normalize_llm_provider_overrides(llm_settings.get("llmProviderOverrides"))
    primary: ResolvedLLMRole = {
        "provider": llm_settings.get("aiProvider", "openai"),
        "model": llm_settings.get("aiModel"),
    }

    if role == "primary":
        return primary

    # Look up the role's own model
    model_field = LLM_ROLE_MODEL_FIELDS[role]
    role_model = llm_settings.get(model_field)  # type: ignore[arg-type]

    # If this role has its own model, use it with its provider (or override)
    if role_model:
        return {
            "provider": overrides.get(role, llm_settings.get("aiProvider", "openai")),  # type: ignore[arg-type]
            "model": role_model,
        }

    # No model set — inherit both provider and model from primary
    return primary


def resolve_all_llm_roles(llm_settings: LLMSettings) -> ResolvedLLMRoleMap:
    """Resolve all LLM roles to their provider + model pairs."""
    return {
        "primary": resolve_llm_role(llm_settings, "primary"),
        "medium": resolve_llm_role(llm_settings, "medium"),
        "light": resolve_llm_role(llm_settings, "light"),
        "explore": resolve_llm_role(llm_settings, "explore"),
        "execute": resolve_llm_role(llm_settings, "execute"),
        "title": resolve_llm_role(llm_settings, "title"),
        "compact": resolve_llm_role(llm_settings, "compact"),
    }


def build_resolved_role_providers(llm_settings: LLMSettings) -> ResolvedRoleProviderMap:
    """Build a map of role → provider for all roles."""
    resolved = resolve_all_llm_roles(llm_settings)
    return {role: info["provider"] for role, info in resolved.items()}
