"""Model discovery — fetch available models from each AI provider.

Replaces: apps/api/src/services/model-discovery.service.ts
"""

from __future__ import annotations

import time
from typing import Any

import httpx
from loguru import logger

_CACHE_TTL_S = 5 * 60  # 5 minutes

# ── Filter config ─────────────────────────────────────────
OPENAI_CHAT_PREFIXES = ("gpt-", "o1", "o3", "o4")
OPENAI_CHAT_EXCLUDES = (
    "realtime", "audio", "search", "transcribe", "tts",
    "dall-e", "whisper", "instruct", "-codex", "moderation",
    "gpt-image", "chatgpt-image", "gpt-oss",
)
OPENAI_EMBEDDING_PREFIXES = ("text-embedding-",)
GEMINI_LLM_EXCLUDES = (
    "image", "tts", "robotics", "computer-use", "deep-research",
    "nano-banana", "gemma", "customtools", "learnlm",
)


# ── Cache ─────────────────────────────────────────────────
class _CacheEntry:
    __slots__ = ("models", "fetched_at")

    def __init__(self, models: list[str]) -> None:
        self.models = models
        self.fetched_at = time.monotonic()

    def is_valid(self) -> bool:
        return (time.monotonic() - self.fetched_at) < _CACHE_TTL_S


_llm_cache: dict[str, _CacheEntry] = {}
_embedding_cache: dict[str, _CacheEntry] = {}


def _get_cached(cache: dict[str, _CacheEntry], key: str) -> list[str] | None:
    entry = cache.get(key)
    if entry and entry.is_valid():
        return entry.models
    if entry:
        del cache[key]
    return None


# ── OpenAI-compatible model listing ───────────────────────

async def _list_openai_compatible_models(
    *,
    api_key: str | None = None,
    base_url: str | None = None,
) -> list[str]:
    """List models from an OpenAI-compatible API."""
    url = (base_url or "https://api.openai.com/v1").rstrip("/") + "/models"
    headers: dict[str, str] = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(url, headers=headers)
        resp.raise_for_status()
        data = resp.json()
        return sorted([m["id"] for m in data.get("data", [])])


async def _fetch_openai_models(api_key: str) -> dict[str, list[str]]:
    all_models = await _list_openai_compatible_models(api_key=api_key)
    return {
        "llm": [
            m for m in all_models
            if any(m.startswith(p) for p in OPENAI_CHAT_PREFIXES)
            and not any(ex in m for ex in OPENAI_CHAT_EXCLUDES)
        ],
        "embedding": [
            m for m in all_models
            if any(m.startswith(p) for p in OPENAI_EMBEDDING_PREFIXES)
        ],
    }


async def _fetch_local_models(base_url: str) -> dict[str, list[str]]:
    all_models = await _list_openai_compatible_models(base_url=base_url)
    return {"llm": all_models, "embedding": all_models}


async def _fetch_anthropic_models(api_key: str) -> dict[str, list[str]]:
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(
            "https://api.anthropic.com/v1/models",
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
            },
            params={"limit": 100},
        )
        resp.raise_for_status()
        data = resp.json()
        models = sorted([m["id"] for m in data.get("data", [])])
        return {"llm": models, "embedding": []}


async def _fetch_gemini_models(api_key: str) -> dict[str, list[str]]:
    all_models: list[dict[str, Any]] = []
    page_token: str | None = None

    async with httpx.AsyncClient(timeout=15.0) as client:
        while True:
            params: dict[str, str] = {"key": api_key, "pageSize": "100"}
            if page_token:
                params["pageToken"] = page_token

            resp = await client.get(
                "https://generativelanguage.googleapis.com/v1beta/models",
                params=params,
            )
            resp.raise_for_status()
            data = resp.json()
            all_models.extend(data.get("models", []))
            page_token = data.get("nextPageToken")
            if not page_token:
                break

    def strip_prefix(name: str) -> str:
        return name.removeprefix("models/")

    return {
        "llm": sorted([
            strip_prefix(m["name"])
            for m in all_models
            if "generateContent" in (m.get("supportedGenerationMethods") or [])
            and not any(ex in m["name"] for ex in GEMINI_LLM_EXCLUDES)
        ]),
        "embedding": sorted([
            strip_prefix(m["name"])
            for m in all_models
            if "embedContent" in (m.get("supportedGenerationMethods") or [])
        ]),
    }


# ── Provider dispatcher ──────────────────────────────────

async def _fetch_provider_models(
    provider: str, connection_value: str
) -> dict[str, list[str]]:
    if provider == "openai":
        return await _fetch_openai_models(connection_value)
    elif provider == "claude":
        result = await _fetch_anthropic_models(connection_value)
        return {**result, "embedding": []}
    elif provider == "gemini":
        return await _fetch_gemini_models(connection_value)
    elif provider == "local":
        return await _fetch_local_models(connection_value)
    return {"llm": [], "embedding": []}


# ── Public API ────────────────────────────────────────────

class ProviderConnectionTestResult:
    __slots__ = ("valid", "reachable", "llm_models", "embedding_models", "message")

    def __init__(
        self,
        *,
        valid: bool,
        reachable: bool,
        llm_models: list[str],
        embedding_models: list[str],
        message: str | None = None,
    ) -> None:
        self.valid = valid
        self.reachable = reachable
        self.llm_models = llm_models
        self.embedding_models = embedding_models
        self.message = message

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "valid": self.valid,
            "reachable": self.reachable,
            "llmModels": self.llm_models,
            "embeddingModels": self.embedding_models,
        }
        if self.message:
            result["message"] = self.message
        return result


async def test_provider_connection(
    provider: str, connection_value: str
) -> ProviderConnectionTestResult:
    trimmed = connection_value.strip()
    if not trimmed:
        return ProviderConnectionTestResult(
            valid=False, reachable=False,
            llm_models=[], embedding_models=[],
            message="Connection value is required",
        )

    try:
        result = await _fetch_provider_models(provider, trimmed)
        has_models = bool(result["llm"] or result["embedding"])
        return ProviderConnectionTestResult(
            valid=has_models, reachable=True,
            llm_models=result["llm"], embedding_models=result["embedding"],
            message=None if has_models else "Connection succeeded but no models were returned",
        )
    except Exception as err:
        return ProviderConnectionTestResult(
            valid=False, reachable=False,
            llm_models=[], embedding_models=[],
            message=str(err),
        )


async def discover_llm_models(provider: str) -> list[str]:
    cached = _get_cached(_llm_cache, provider)
    if cached is not None:
        return cached

    try:
        from clawbuddy.services.settings_service import settings_service

        connection_value = await settings_service.get_provider_connection_value(provider)
        if not connection_value:
            return []

        result = await _fetch_provider_models(provider, connection_value)

        _llm_cache[provider] = _CacheEntry(result["llm"])
        if result["embedding"]:
            _embedding_cache[provider] = _CacheEntry(result["embedding"])

        return result["llm"]
    except Exception as err:
        logger.warning(f"[model-discovery] Failed to fetch models for {provider}: {err}")
        return []


async def discover_embedding_models(provider: str) -> list[str]:
    cached = _get_cached(_embedding_cache, provider)
    if cached is not None:
        return cached

    try:
        from clawbuddy.services.settings_service import settings_service

        connection_value = await settings_service.get_provider_connection_value(provider)
        if not connection_value:
            return []

        result = await _fetch_provider_models(provider, connection_value)

        if result["llm"]:
            _llm_cache[provider] = _CacheEntry(result["llm"])
        _embedding_cache[provider] = _CacheEntry(result["embedding"])

        return result["embedding"]
    except Exception as err:
        logger.warning(f"[model-discovery] Failed to fetch embedding models for {provider}: {err}")
        return []


async def build_model_catalogs(
    available: dict[str, list[str]],
) -> dict[str, dict[str, list[str]]]:
    """Build a full model catalog keyed by provider for both LLM and embedding."""
    llm_entries: dict[str, list[str]] = {}
    for p in available["llm"]:
        llm_entries[p] = await discover_llm_models(p)

    embedding_entries: dict[str, list[str]] = {}
    for p in available["embedding"]:
        embedding_entries[p] = await discover_embedding_models(p)

    return {"llm": llm_entries, "embedding": embedding_entries}


def invalidate_model_cache(provider: str | None = None) -> None:
    """Invalidate cache for a provider (e.g. after API key change)."""
    if provider:
        _llm_cache.pop(provider, None)
        _embedding_cache.pop(provider, None)
    else:
        _llm_cache.clear()
        _embedding_cache.clear()
