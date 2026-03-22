"""Application settings service with 30-second cache.

Replaces: apps/api/src/services/settings.service.ts
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING, Any

from sqlalchemy import select

from clawbuddy.config import (
    DB_KEY_FIELDS,
    EMBEDDING_PROVIDERS,
    ENV_BASE_URLS,
    ENV_KEYS,
    LLM_PROVIDERS,
    PROVIDER_METADATA,
)
from clawbuddy.constants import (
    DEFAULT_BROWSER_GRID_URL,
    DEFAULT_BROWSER_TYPE,
    DEFAULT_CONTEXT_LIMIT_TOKENS,
    DEFAULT_MAX_AGENT_ITERATIONS,
    KEY_MASK_THRESHOLD,
    MAX_CONTEXT_LIMIT_TOKENS,
    MIN_CONTEXT_LIMIT_TOKENS,
    SUB_AGENT_ANALYZE_MAX_ITERATIONS,
    SUB_AGENT_EXECUTE_MAX_ITERATIONS,
    SUB_AGENT_EXPLORE_MAX_ITERATIONS,
)
from clawbuddy.db.models import AppSettings
from clawbuddy.db.session import get_db_context
from clawbuddy.lib.errors import ConfigurationError, ValidationError
from clawbuddy.lib.llm_resolver import (
    LLMRole,
    ResolvedRoleProviderMap,
    build_resolved_role_providers,
    merge_llm_provider_overrides,
    resolve_all_llm_roles,
    resolve_llm_role,
)
from clawbuddy.services.crypto import decrypt, encrypt
from clawbuddy.settings import settings as env

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

_CACHE_TTL_S = 30.0

# ── Module-level cache ─────────────────────────────────────────
_cache: dict[str, Any] | None = None
_cache_time: float = 0.0


def _invalidate_cache() -> None:
    global _cache, _cache_time
    _cache = None
    _cache_time = 0.0


def _camel_to_snake(name: str) -> str:
    """Convert camelCase to snake_case for ORM attribute access."""
    import re
    return re.sub(r"(?<=[a-z0-9])([A-Z])", r"_\1", name).lower()


def _mask(key: str) -> str:
    if len(key) <= KEY_MASK_THRESHOLD:
        return "****"
    return "****" + key[-4:]


def _settings_to_dict(row: AppSettings) -> dict[str, Any]:
    """Convert an AppSettings ORM row to a plain dict for caching.

    Uses the DB column name (camelCase) as dict key so that all existing code
    that accesses settings["aiProvider"] etc. continues to work unchanged.
    """
    return {
        attr.columns[0].name: getattr(row, attr.key)
        for attr in row.__mapper__.column_attrs
    }


class SettingsService:
    """Singleton-patterned settings service backed by the ``AppSettings`` table."""

    # ── Core get/cache ─────────────────────────────────────────

    async def get(self, db: AsyncSession | None = None) -> dict[str, Any]:
        """Get the singleton AppSettings record (cached for 30s)."""
        global _cache, _cache_time
        now = time.monotonic()
        if _cache is not None and (now - _cache_time) < _CACHE_TTL_S:
            return _cache

        async def _load(session: AsyncSession) -> dict[str, Any]:
            global _cache, _cache_time
            result = await session.execute(
                select(AppSettings).where(AppSettings.id == "singleton")
            )
            row = result.scalar_one_or_none()
            if row:
                d = _settings_to_dict(row)
                _cache = d
                _cache_time = time.monotonic()
                return d
            # Create default row
            new_row = AppSettings(
                id="singleton",
                ai_provider=env.AI_PROVIDER,
                embedding_provider=env.EMBEDDING_PROVIDER,
            )
            session.add(new_row)
            await session.commit()
            await session.refresh(new_row)
            d = _settings_to_dict(new_row)
            _cache = d
            _cache_time = time.monotonic()
            return d

        if db is not None:
            return await _load(db)
        async with get_db_context() as session:
            return await _load(session)

    def invalidate_cache(self) -> None:
        _invalidate_cache()

    # ── Simple getters ─────────────────────────────────────────

    async def get_ai_provider(self, db: AsyncSession | None = None) -> str:
        return (await self.get(db))["aiProvider"]

    async def get_embedding_provider(self, db: AsyncSession | None = None) -> str:
        return (await self.get(db))["embeddingProvider"]

    async def get_ai_model(self, db: AsyncSession | None = None) -> str:
        return (await self.get(db))["aiModel"]

    async def get_resolved_llm_role(
        self, role: LLMRole, db: AsyncSession | None = None
    ) -> dict[str, Any]:
        s = await self.get(db)
        return resolve_llm_role(s, role)  # type: ignore[arg-type]

    async def get_resolved_role_providers(
        self, db: AsyncSession | None = None
    ) -> ResolvedRoleProviderMap:
        s = await self.get(db)
        return build_resolved_role_providers(s)  # type: ignore[arg-type]

    async def get_advanced_model_config(self, db: AsyncSession | None = None) -> bool:
        return (await self.get(db))["advancedModelConfig"]

    async def get_embedding_model(self, db: AsyncSession | None = None) -> str:
        return (await self.get(db))["embeddingModel"]

    async def get_context_limit_tokens(self, db: AsyncSession | None = None) -> int:
        return await self._get_numeric("contextLimitTokens", DEFAULT_CONTEXT_LIMIT_TOKENS, db)

    async def get_timezone(self, db: AsyncSession | None = None) -> str:
        s = await self.get(db)
        return s.get("timezone") or "UTC"

    async def get_dismissed_update_version(self, db: AsyncSession | None = None) -> str | None:
        s = await self.get(db)
        return s.get("dismissedUpdateVersion")

    async def get_max_agent_iterations(self, db: AsyncSession | None = None) -> int:
        return await self._get_numeric("maxAgentIterations", DEFAULT_MAX_AGENT_ITERATIONS, db)

    async def get_sub_agent_explore_max_iterations(self, db: AsyncSession | None = None) -> int:
        return await self._get_numeric(
            "subAgentExploreMaxIterations", SUB_AGENT_EXPLORE_MAX_ITERATIONS, db
        )

    async def get_sub_agent_analyze_max_iterations(self, db: AsyncSession | None = None) -> int:
        return await self._get_numeric(
            "subAgentAnalyzeMaxIterations", SUB_AGENT_ANALYZE_MAX_ITERATIONS, db
        )

    async def get_sub_agent_execute_max_iterations(self, db: AsyncSession | None = None) -> int:
        return await self._get_numeric(
            "subAgentExecuteMaxIterations", SUB_AGENT_EXECUTE_MAX_ITERATIONS, db
        )

    async def get_browser_grid_url(self) -> str:
        if env.BROWSER_GRID_URL:
            return env.BROWSER_GRID_URL
        s = await self.get()
        return s.get("browserGridUrl") or DEFAULT_BROWSER_GRID_URL

    async def get_browser_grid_api_key(self) -> str | None:
        if env.BROWSER_GRID_API_KEY:
            return env.BROWSER_GRID_API_KEY
        s = await self.get()
        encrypted = s.get("browserGridApiKey")
        if not encrypted:
            return None
        try:
            return decrypt(encrypted)
        except Exception:
            return None

    async def get_browser_grid_browser(self) -> str:
        s = await self.get()
        return s.get("browserGridBrowser") or DEFAULT_BROWSER_TYPE

    async def get_browser_model(self) -> str | None:
        s = await self.get()
        return s.get("browserModel")

    # ── Model resolution ───────────────────────────────────────

    async def _resolve_model(
        self, model_key: str, fallback_tier_key: str | None, db: AsyncSession | None = None
    ) -> str:
        s = await self.get(db)
        if fallback_tier_key and s.get("advancedModelConfig") and s.get(model_key):
            return s[model_key]
        tier_key = fallback_tier_key or model_key
        tier_value = s.get(tier_key)
        return tier_value or s["aiModel"]

    async def get_light_model(self, db: AsyncSession | None = None) -> str:
        return await self._resolve_model("lightModel", None, db)

    async def get_title_model(self, db: AsyncSession | None = None) -> str:
        return await self._resolve_model("titleModel", "lightModel", db)

    async def get_compact_model(self, db: AsyncSession | None = None) -> str:
        return await self._resolve_model("compactModel", "mediumModel", db)

    async def get_medium_model(self, db: AsyncSession | None = None) -> str:
        return await self._resolve_model("mediumModel", None, db)

    async def get_explore_model(self, db: AsyncSession | None = None) -> str:
        return await self._resolve_model("exploreModel", "lightModel", db)

    async def get_execute_model(self, db: AsyncSession | None = None) -> str:
        return await self._resolve_model("executeModel", "mediumModel", db)

    # ── API key management ─────────────────────────────────────

    async def get_api_key(self, provider: str) -> str | None:
        env_key = ENV_KEYS.get(provider)
        if env_key:
            return env_key
        field = DB_KEY_FIELDS.get(provider)
        if not field:
            return None
        s = await self.get()
        encrypted = s.get(field)
        if not encrypted:
            return None
        try:
            return decrypt(encrypted)
        except Exception:
            return None

    async def get_local_base_url(self) -> str | None:
        env_url = ENV_BASE_URLS.get("local", "").strip()
        if env_url:
            return env_url
        s = await self.get()
        val = (s.get("localBaseUrl") or "").strip()
        return val or None

    async def get_provider_connection_value(self, provider: str) -> str | None:
        if provider == "local":
            return await self.get_local_base_url()
        return await self.get_api_key(provider)

    async def is_provider_configured(self, provider: str) -> bool:
        value = await self.get_provider_connection_value(provider)
        return bool(value and value.strip())

    async def get_configured_providers(self) -> dict[str, list[str]]:
        llm = [p for p in LLM_PROVIDERS if await self.is_provider_configured(p)]
        embedding = [p for p in EMBEDDING_PROVIDERS if await self.is_provider_configured(p)]
        return {"llm": llm, "embedding": embedding}

    # Map provider name → ORM attribute name for API key fields
    _DB_KEY_ATTRS: dict[str, str] = {
        "openai": "openai_api_key",
        "gemini": "gemini_api_key",
        "claude": "anthropic_api_key",
    }

    async def set_api_key(self, provider: str, plaintext: str) -> None:
        attr = self._DB_KEY_ATTRS.get(provider)
        if not attr:
            raise ConfigurationError(f"Unknown provider: {provider}")
        await self.get()  # ensure row exists
        value = encrypt(plaintext.strip()) if plaintext.strip() else None
        async with get_db_context() as session:
            result = await session.execute(
                select(AppSettings).where(AppSettings.id == "singleton")
            )
            row = result.scalar_one()
            setattr(row, attr, value)
            await session.commit()
        _invalidate_cache()

    async def set_provider_connection(self, provider: str, plaintext: str) -> None:
        trimmed = plaintext.strip()
        if not trimmed:
            raise ValidationError("Connection value cannot be empty")
        if provider == "local":
            await self.get()
            async with get_db_context() as session:
                result = await session.execute(
                    select(AppSettings).where(AppSettings.id == "singleton")
                )
                row = result.scalar_one()
                row.local_base_url = trimmed
                await session.commit()
            _invalidate_cache()
            return
        await self.set_api_key(provider, trimmed)

    async def remove_api_key(self, provider: str) -> None:
        attr = self._DB_KEY_ATTRS.get(provider)
        if not attr:
            raise ConfigurationError(f"Unknown provider: {provider}")
        async with get_db_context() as session:
            result = await session.execute(
                select(AppSettings).where(AppSettings.id == "singleton")
            )
            row = result.scalar_one()
            setattr(row, attr, None)
            await session.commit()
        _invalidate_cache()

    async def remove_provider_connection(self, provider: str) -> None:
        if provider == "local":
            async with get_db_context() as session:
                result = await session.execute(
                    select(AppSettings).where(AppSettings.id == "singleton")
                )
                row = result.scalar_one()
                row.local_base_url = None
                await session.commit()
            _invalidate_cache()
            return
        await self.remove_api_key(provider)

    async def get_available_providers(self) -> dict[str, list[str]]:
        """Get providers that are both configured AND have discoverable models."""
        # Lazy import to avoid circular dependency
        from clawbuddy.services.model_discovery import discover_embedding_models, discover_llm_models

        configured = await self.get_configured_providers()
        llm_available: list[str] = []
        for p in configured["llm"]:
            models = await discover_llm_models(p)
            if models:
                llm_available.append(p)

        embedding_available: list[str] = []
        for p in configured["embedding"]:
            models = await discover_embedding_models(p)
            if models:
                embedding_available.append(p)

        return {"llm": llm_available, "embedding": embedding_available}

    def get_provider_metadata(self) -> dict[str, Any]:
        return PROVIDER_METADATA

    async def get_provider_connections(self) -> dict[str, dict[str, Any]]:
        s = await self.get()
        result: dict[str, dict[str, Any]] = {}

        for provider in PROVIDER_METADATA:
            env_key = ENV_KEYS.get(provider)
            if env_key:
                result[provider] = {"source": "env", "value": _mask(env_key)}
                continue

            env_base_url = ENV_BASE_URLS.get(provider)
            if env_base_url:
                result[provider] = {"source": "env", "value": env_base_url}
                continue

            field = DB_KEY_FIELDS.get(provider)
            encrypted = s.get(field) if field else None
            if encrypted:
                try:
                    result[provider] = {"source": "db", "value": _mask(decrypt(encrypted))}
                except Exception:
                    result[provider] = {"source": None, "value": None}
                continue

            if provider == "local" and s.get("localBaseUrl"):
                result[provider] = {"source": "db", "value": s["localBaseUrl"]}
                continue

            result[provider] = {"source": None, "value": None}

        return result

    async def get_google_credentials(self) -> dict[str, str] | None:
        if not env.GOOGLE_CLIENT_ID or not env.GOOGLE_CLIENT_SECRET:
            return None
        return {"clientId": env.GOOGLE_CLIENT_ID, "clientSecret": env.GOOGLE_CLIENT_SECRET}

    def is_google_oauth_configured(self) -> bool:
        return bool(env.GOOGLE_CLIENT_ID and env.GOOGLE_CLIENT_SECRET)

    async def complete_onboarding(self) -> None:
        await self.get()
        async with get_db_context() as session:
            result = await session.execute(
                select(AppSettings).where(AppSettings.id == "singleton")
            )
            row = result.scalar_one()
            row.onboarding_complete = True
            await session.commit()
        _invalidate_cache()

    async def set_browser_grid_api_key(self, plaintext: str) -> None:
        await self.get()
        value = encrypt(plaintext.strip()) if plaintext.strip() else None
        async with get_db_context() as session:
            result = await session.execute(
                select(AppSettings).where(AppSettings.id == "singleton")
            )
            row = result.scalar_one()
            row.browser_grid_api_key = value
            await session.commit()
        _invalidate_cache()

    async def set_dismissed_update_version(self, version: str | None) -> None:
        await self.get()
        async with get_db_context() as session:
            result = await session.execute(
                select(AppSettings).where(AppSettings.id == "singleton")
            )
            row = result.scalar_one()
            row.dismissed_update_version = version.strip() if version else None
            await session.commit()
        _invalidate_cache()

    async def update(self, data: dict[str, Any]) -> dict[str, Any]:
        """Update settings with validation."""
        from clawbuddy.services.model_discovery import discover_embedding_models, discover_llm_models

        s = await self.get()
        available = await self.get_available_providers()

        # Build next settings state for validation
        next_settings = dict(s)
        for key in (
            "aiProvider", "aiModel", "mediumModel", "lightModel",
            "exploreModel", "executeModel", "titleModel", "compactModel",
            "advancedModelConfig", "embeddingProvider", "embeddingModel",
        ):
            if key in data and data[key] is not None:
                next_settings[key] = data[key]

        # Handle role provider overrides
        if "roleProviders" in data and data["roleProviders"]:
            next_settings["llmProviderOverrides"] = merge_llm_provider_overrides(
                s.get("llmProviderOverrides"), data["roleProviders"]
            )

        # Lock embedding settings after onboarding
        if s.get("onboardingComplete") and (
            data.get("embeddingProvider") or data.get("embeddingModel")
        ):
            raise ValidationError("Embedding model cannot be changed after initial setup")

        # Validate AI provider
        if next_settings.get("aiProvider") and next_settings["aiProvider"] not in available["llm"]:
            raise ValidationError(
                f'AI provider "{next_settings["aiProvider"]}" is not available '
                f"(missing catalog or connection)"
            )

        # Validate embedding provider
        if (
            next_settings.get("embeddingProvider")
            and next_settings["embeddingProvider"] not in available["embedding"]
        ):
            raise ValidationError(
                f'Embedding provider "{next_settings["embeddingProvider"]}" is not available '
                f"(missing catalog or connection)"
            )

        # Validate each role's model
        resolved_roles = resolve_all_llm_roles(next_settings)  # type: ignore[arg-type]
        for role, selection in resolved_roles.items():
            if not selection["model"]:
                continue
            if selection["provider"] not in available["llm"]:
                raise ValidationError(
                    f'Provider "{selection["provider"]}" is not available for role "{role}"'
                )
            llm_models = await discover_llm_models(selection["provider"])
            if not llm_models:
                raise ValidationError(
                    f'Provider "{selection["provider"]}" has no available catalog for role "{role}"'
                )
            if selection["model"] not in llm_models:
                raise ValidationError(
                    f'Model "{selection["model"]}" is not available for provider "{selection["provider"]}"'
                )

        # Validate embedding model
        if next_settings.get("embeddingModel") and next_settings.get("embeddingProvider"):
            models = await discover_embedding_models(next_settings["embeddingProvider"])
            if not models:
                raise ValidationError(
                    f'Embedding provider "{next_settings["embeddingProvider"]}" has no available catalog'
                )
            if next_settings["embeddingModel"] not in models:
                raise ValidationError(
                    f'Model "{next_settings["embeddingModel"]}" is not available for '
                    f'provider "{next_settings["embeddingProvider"]}"'
                )

        # Validate context limit
        if (
            "contextLimitTokens" in data
            and data["contextLimitTokens"] is not None
            and not (
                MIN_CONTEXT_LIMIT_TOKENS
                <= data["contextLimitTokens"]
                <= MAX_CONTEXT_LIMIT_TOKENS
            )
        ):
            raise ValidationError(
                f"Context limit must be between {MIN_CONTEXT_LIMIT_TOKENS:,} "
                f"and {MAX_CONTEXT_LIMIT_TOKENS:,} tokens"
            )

        # Persist
        persist_data = {k: v for k, v in data.items() if k != "roleProviders"}
        if "roleProviders" in data and data["roleProviders"]:
            persist_data["llmProviderOverrides"] = next_settings["llmProviderOverrides"]

        async with get_db_context() as session:
            result = await session.execute(
                select(AppSettings).where(AppSettings.id == "singleton")
            )
            row = result.scalar_one()
            for key, value in persist_data.items():
                attr = _camel_to_snake(key)
                if hasattr(row, attr):
                    setattr(row, attr, value)
            await session.commit()
            await session.refresh(row)
            updated = _settings_to_dict(row)

        _invalidate_cache()
        return updated

    # ── Private helpers ────────────────────────────────────────

    async def _get_numeric(
        self, key: str, fallback: int, db: AsyncSession | None = None
    ) -> int:
        s = await self.get(db)
        val = s.get(key)
        return val if val is not None else fallback


# Module-level singleton
settings_service = SettingsService()
