"""Environment configuration via pydantic-settings.

Replaces: apps/api/src/env.ts
"""

from __future__ import annotations

from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = SettingsConfigDict(
        env_file="../.env",
        env_file_encoding="utf-8",
        case_sensitive=True,
        extra="ignore",
    )

    # Database & cache
    DATABASE_URL: str
    REDIS_URL: str
    QDRANT_URL: str

    # Object storage (MinIO)
    MINIO_ENDPOINT: str
    MINIO_ACCESS_KEY: str
    MINIO_SECRET_KEY: str
    MINIO_BUCKET: str

    # Encryption
    ENCRYPTION_SECRET: str = Field(min_length=16)

    # App URL (CORS & OAuth redirects)
    APP_URL: str = "http://localhost:5173"

    # AI providers
    AI_PROVIDER: Literal["openai", "gemini", "claude", "local"] = "openai"
    EMBEDDING_PROVIDER: Literal["openai", "gemini", "local"] = "openai"
    OPENAI_API_KEY: str = ""
    GEMINI_API_KEY: str = ""
    ANTHROPIC_API_KEY: str = ""
    LOCAL_PROVIDER_BASE_URL: str = ""

    # Google OAuth
    GOOGLE_CLIENT_ID: str = ""
    GOOGLE_CLIENT_SECRET: str = ""

    # Browser grid
    BROWSER_GRID_URL: str = ""
    BROWSER_GRID_API_KEY: str = ""

    # Debug flags
    DEBUG_AGENT: str = ""
    UPDATE_FORCE: str = ""

    # Build metadata
    CLAWBUDDY_VERSION: str = "dev"
    CLAWBUDDY_COMMIT_SHA: str = "local"
    CLAWBUDDY_BUILD_TIME: str = ""

    # Encryption salt (optional override)
    ENCRYPTION_SALT: str = "clawbuddy-api-key-encryption"

    @field_validator("ENCRYPTION_SECRET")
    @classmethod
    def validate_encryption_secret(cls, v: str) -> str:
        if len(v) < 16:
            raise ValueError("ENCRYPTION_SECRET must be at least 16 characters")
        return v

    @property
    def has_any_provider_connection(self) -> bool:
        """Check if at least one AI provider is configured."""
        return bool(
            self.OPENAI_API_KEY
            or self.GEMINI_API_KEY
            or self.ANTHROPIC_API_KEY
            or self.LOCAL_PROVIDER_BASE_URL
        )

    @property
    def redis_host(self) -> str:
        """Extract host from REDIS_URL."""
        from urllib.parse import urlparse

        parsed = urlparse(self.REDIS_URL)
        return parsed.hostname or "localhost"

    @property
    def redis_port(self) -> int:
        """Extract port from REDIS_URL."""
        from urllib.parse import urlparse

        parsed = urlparse(self.REDIS_URL)
        return parsed.port or 6379

    @property
    def redis_db(self) -> int:
        """Extract db number from REDIS_URL."""
        from urllib.parse import urlparse

        parsed = urlparse(self.REDIS_URL)
        path = parsed.path or ""
        if path.startswith("/") and len(path) > 1:
            try:
                return int(path[1:])
            except ValueError:
                pass
        return 0


def get_settings() -> Settings:
    """Create and cache settings instance."""
    return Settings()  # type: ignore[call-arg]


# Module-level singleton
settings = get_settings()

# Startup warning
if not settings.has_any_provider_connection:
    import warnings

    warnings.warn(
        "No AI provider connections configured. Set at least one of: "
        "OPENAI_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY, LOCAL_PROVIDER_BASE_URL",
        UserWarning,
        stacklevel=1,
    )
