"""Workspace export/import schemas.

Replaces: packages/shared/src/schemas/workspace-export.schema.ts
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class WorkspaceExportCapability(BaseModel):
    """Capability config in a workspace export."""

    slug: str
    enabled: bool
    config: dict[str, Any] | None = None


class WorkspaceExportChannel(BaseModel):
    """Channel config in a workspace export."""

    type: str
    name: str
    enabled: bool
    config: dict[str, Any]


class WorkspaceExportModelConfig(BaseModel):
    """Model/provider config in a workspace export."""

    ai_provider: str = Field(alias="aiProvider")
    ai_model: str | None = Field(alias="aiModel")

    # Role providers
    role_providers: dict[str, str] | None = Field(default=None, alias="roleProviders")

    # Role-specific models
    medium_model: str | None = Field(default=None, alias="mediumModel")
    light_model: str | None = Field(default=None, alias="lightModel")
    explore_model: str | None = Field(default=None, alias="exploreModel")
    execute_model: str | None = Field(default=None, alias="executeModel")
    title_model: str | None = Field(default=None, alias="titleModel")
    compact_model: str | None = Field(default=None, alias="compactModel")

    advanced_model_config: bool | None = Field(default=None, alias="advancedModelConfig")

    # Embeddings
    embedding_provider: str = Field(alias="embeddingProvider")
    embedding_model: str | None = Field(alias="embeddingModel")

    # Local provider
    local_base_url: str | None = Field(default=None, alias="localBaseUrl")

    # Agent limits
    context_limit_tokens: int | None = Field(default=None, alias="contextLimitTokens")
    max_agent_iterations: int | None = Field(default=None, alias="maxAgentIterations")
    sub_agent_explore_max_iterations: int | None = Field(default=None, alias="subAgentExploreMaxIterations")
    sub_agent_analyze_max_iterations: int | None = Field(default=None, alias="subAgentAnalyzeMaxIterations")
    sub_agent_execute_max_iterations: int | None = Field(default=None, alias="subAgentExecuteMaxIterations")

    # Misc
    timezone: str | None = None

    model_config = {"populate_by_name": True}


class WorkspaceExportWorkspace(BaseModel):
    """Workspace data in a workspace export."""

    name: str
    description: str | None = None
    color: str | None = None
    auto_execute: bool = Field(alias="autoExecute")
    settings: dict[str, Any] | None = None
    permissions: dict[str, Any] | None = None

    model_config = {"populate_by_name": True}


class WorkspaceExport(BaseModel):
    """Full workspace export schema."""

    version: Literal[1] = 1
    exported_at: str = Field(alias="exportedAt")
    workspace: WorkspaceExportWorkspace
    capabilities: list[WorkspaceExportCapability]
    channels: list[WorkspaceExportChannel]
    model_config_data: WorkspaceExportModelConfig = Field(alias="modelConfig")
    token_usage: Any | None = Field(default=None, alias="tokenUsage")

    model_config = {"populate_by_name": True}
