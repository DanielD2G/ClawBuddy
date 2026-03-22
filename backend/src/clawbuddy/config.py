"""Provider metadata and model configuration.

Replaces: apps/api/src/config.ts
"""

from __future__ import annotations

import re
from typing import Literal, TypedDict

from clawbuddy.settings import settings

# ── Provider types ───────────────────────────────────────────

LLMProviderName = Literal["openai", "gemini", "claude", "local"]
EmbeddingProviderName = Literal["openai", "gemini", "local"]
ProviderConnectionType = Literal["apiKey", "baseUrl"]

LLM_PROVIDERS: list[LLMProviderName] = ["openai", "gemini", "claude", "local"]
EMBEDDING_PROVIDERS: list[EmbeddingProviderName] = ["openai", "gemini", "local"]


class ProviderSupports(TypedDict):
    llm: bool
    embedding: bool


class ProviderMeta(TypedDict):
    label: str
    connectionType: ProviderConnectionType
    supports: ProviderSupports


PROVIDER_METADATA: dict[str, ProviderMeta] = {
    "openai": {
        "label": "OpenAI",
        "connectionType": "apiKey",
        "supports": {"llm": True, "embedding": True},
    },
    "gemini": {
        "label": "Google Gemini",
        "connectionType": "apiKey",
        "supports": {"llm": True, "embedding": True},
    },
    "claude": {
        "label": "Anthropic Claude",
        "connectionType": "apiKey",
        "supports": {"llm": True, "embedding": False},
    },
    "local": {
        "label": "Local Provider",
        "connectionType": "baseUrl",
        "supports": {"llm": True, "embedding": True},
    },
}


def supports_vision(model_id: str) -> bool:
    """Check if a model supports vision/multimodal input based on naming conventions."""
    # o1 does not support vision; o3+ do
    if model_id.startswith("o1"):
        return False
    # All GPT-4+, Gemini, Claude, and o3/o4 models support vision
    if model_id.startswith(("gpt-4", "gpt-5")):
        return True
    if re.match(r"^o[3-9]", model_id):
        return True
    if model_id.startswith("gemini-"):
        return True
    if model_id.startswith("claude-"):
        return True
    return False


# ── Environment key mapping ──────────────────────────────────

ENV_KEYS: dict[str, str] = {
    "openai": settings.OPENAI_API_KEY,
    "gemini": settings.GEMINI_API_KEY,
    "claude": settings.ANTHROPIC_API_KEY,
}

DB_KEY_FIELDS: dict[str, str] = {
    "openai": "openaiApiKey",
    "gemini": "geminiApiKey",
    "claude": "anthropicApiKey",
}

ENV_BASE_URLS: dict[str, str] = {
    "local": settings.LOCAL_PROVIDER_BASE_URL,
}
