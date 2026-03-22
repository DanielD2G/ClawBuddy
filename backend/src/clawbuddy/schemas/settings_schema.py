"""Settings schemas.

Replaces: inline Zod schemas from routes/settings.ts
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class UpdateSettingsInput(BaseModel):
    """Update global app settings."""

    # AI provider
    ai_provider: str | None = Field(default=None, alias="aiProvider")
    ai_model: str | None = Field(default=None, alias="aiModel")

    # Role-specific models
    medium_model: str | None = Field(default=None, alias="mediumModel")
    light_model: str | None = Field(default=None, alias="lightModel")
    explore_model: str | None = Field(default=None, alias="exploreModel")
    execute_model: str | None = Field(default=None, alias="executeModel")
    title_model: str | None = Field(default=None, alias="titleModel")
    compact_model: str | None = Field(default=None, alias="compactModel")

    # Advanced model config
    advanced_model_config: bool | None = Field(default=None, alias="advancedModelConfig")
    llm_provider_overrides: dict[str, str] | None = Field(default=None, alias="llmProviderOverrides")

    # Embeddings
    embedding_provider: str | None = Field(default=None, alias="embeddingProvider")
    embedding_model: str | None = Field(default=None, alias="embeddingModel")

    # API keys
    openai_api_key: str | None = Field(default=None, alias="openaiApiKey")
    gemini_api_key: str | None = Field(default=None, alias="geminiApiKey")
    anthropic_api_key: str | None = Field(default=None, alias="anthropicApiKey")

    # Local provider
    local_base_url: str | None = Field(default=None, alias="localBaseUrl")

    # Agent config
    context_limit_tokens: int | None = Field(default=None, alias="contextLimitTokens")
    max_agent_iterations: int | None = Field(default=None, alias="maxAgentIterations")
    sub_agent_explore_max_iterations: int | None = Field(default=None, alias="subAgentExploreMaxIterations")
    sub_agent_analyze_max_iterations: int | None = Field(default=None, alias="subAgentAnalyzeMaxIterations")
    sub_agent_execute_max_iterations: int | None = Field(default=None, alias="subAgentExecuteMaxIterations")

    # Misc
    timezone: str | None = None

    model_config = {"populate_by_name": True}


class SetupInput(BaseModel):
    """Initial setup request body."""

    ai_provider: str = Field(alias="aiProvider")
    ai_model: str | None = Field(default=None, alias="aiModel")
    api_key: str | None = Field(default=None, alias="apiKey")
    local_base_url: str | None = Field(default=None, alias="localBaseUrl")
    embedding_provider: str | None = Field(default=None, alias="embeddingProvider")
    embedding_model: str | None = Field(default=None, alias="embeddingModel")

    model_config = {"populate_by_name": True}
