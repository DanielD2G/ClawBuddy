"""SQLAlchemy 2.0 ORM models matching the Prisma schema exactly.

Replaces: apps/api/prisma/schema.prisma

CRITICAL: Table names must match Prisma's output exactly (PascalCase).
DB column names are camelCase (from Prisma) — mapped via explicit column name
in mapped_column("camelCase", ...) while Python attributes use snake_case.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from cuid2 import cuid_wrapper
from sqlalchemy import (
    ARRAY,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

# CUID generator matching Prisma's cuid() default
_generate_cuid = cuid_wrapper()


def generate_cuid() -> str:
    """Generate a CUID compatible with Prisma's @default(cuid())."""
    return _generate_cuid()


class Base(DeclarativeBase):
    """Base class for all models."""

    type_annotation_map = {
        dict[str, Any]: JSONB,
        list[dict[str, Any]]: JSONB,
        Optional[dict[str, Any]]: JSONB,
    }


# ── Workspace ────────────────────────────────────────────────


class Workspace(Base):
    __tablename__ = "Workspace"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=generate_cuid)
    name: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    permissions: Mapped[Optional[dict[str, Any]]] = mapped_column(JSONB, nullable=True)
    color: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    settings: Mapped[Optional[dict[str, Any]]] = mapped_column(JSONB, nullable=True)
    auto_execute: Mapped[bool] = mapped_column("autoExecute", Boolean, default=False, nullable=False)
    container_id: Mapped[Optional[str]] = mapped_column("containerId", String, nullable=True)
    container_status: Mapped[str] = mapped_column("containerStatus", String, default="stopped", nullable=False)
    container_last_activity_at: Mapped[Optional[datetime]] = mapped_column(
        "containerLastActivityAt", DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        "createdAt", DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        "updatedAt", DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    # Relationships
    folders: Mapped[list[Folder]] = relationship("Folder", back_populates="workspace", cascade="all, delete-orphan")
    documents: Mapped[list[Document]] = relationship(
        "Document", back_populates="workspace", cascade="all, delete-orphan"
    )
    chat_sessions: Mapped[list[ChatSession]] = relationship(
        "ChatSession", back_populates="workspace", cascade="all, delete-orphan"
    )
    workspace_capabilities: Mapped[list[WorkspaceCapability]] = relationship(
        "WorkspaceCapability", back_populates="workspace", cascade="all, delete-orphan"
    )
    sandbox_sessions: Mapped[list[SandboxSession]] = relationship(
        "SandboxSession", back_populates="workspace", cascade="all, delete-orphan"
    )
    channels: Mapped[list[Channel]] = relationship(
        "Channel", back_populates="workspace", cascade="all, delete-orphan"
    )


# ── Folder ───────────────────────────────────────────────────


class Folder(Base):
    __tablename__ = "Folder"
    __table_args__ = (Index("Folder_workspaceId_idx", "workspaceId"),)

    id: Mapped[str] = mapped_column(String, primary_key=True, default=generate_cuid)
    name: Mapped[str] = mapped_column(String, nullable=False)
    workspace_id: Mapped[str] = mapped_column(
        "workspaceId", String, ForeignKey("Workspace.id", ondelete="CASCADE"), nullable=False
    )
    parent_id: Mapped[Optional[str]] = mapped_column(
        "parentId", String, ForeignKey("Folder.id"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        "createdAt", DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        "updatedAt", DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    # Relationships
    workspace: Mapped[Workspace] = relationship("Workspace", back_populates="folders")
    parent: Mapped[Optional[Folder]] = relationship(
        "Folder", remote_side="Folder.id", back_populates="children"
    )
    children: Mapped[list[Folder]] = relationship("Folder", back_populates="parent")
    documents: Mapped[list[Document]] = relationship("Document", back_populates="folder")


# ── Document ─────────────────────────────────────────────────


class Document(Base):
    __tablename__ = "Document"
    __table_args__ = (Index("Document_workspaceId_idx", "workspaceId"),)

    id: Mapped[str] = mapped_column(String, primary_key=True, default=generate_cuid)
    title: Mapped[str] = mapped_column(String, nullable=False)
    workspace_id: Mapped[str] = mapped_column(
        "workspaceId", String, ForeignKey("Workspace.id", ondelete="CASCADE"), nullable=False
    )
    folder_id: Mapped[Optional[str]] = mapped_column(
        "folderId", String, ForeignKey("Folder.id", ondelete="SET NULL"), nullable=True
    )
    status: Mapped[str] = mapped_column(String, default="PENDING", nullable=False)
    type: Mapped[str] = mapped_column(String, nullable=False)
    file_url: Mapped[Optional[str]] = mapped_column("fileUrl", String, nullable=True)
    content: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    chunk_count: Mapped[int] = mapped_column("chunkCount", Integer, default=0, nullable=False)
    processing_step: Mapped[Optional[str]] = mapped_column("processingStep", String, nullable=True)
    processing_pct: Mapped[Optional[int]] = mapped_column("processingPct", Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        "createdAt", DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        "updatedAt", DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    # Relationships
    workspace: Mapped[Workspace] = relationship("Workspace", back_populates="documents")
    folder: Mapped[Optional[Folder]] = relationship("Folder", back_populates="documents")
    chunks: Mapped[list[DocumentChunk]] = relationship(
        "DocumentChunk", back_populates="document", cascade="all, delete-orphan"
    )


# ── DocumentChunk ────────────────────────────────────────────


class DocumentChunk(Base):
    __tablename__ = "DocumentChunk"
    __table_args__ = (Index("DocumentChunk_documentId_idx", "documentId"),)

    id: Mapped[str] = mapped_column(String, primary_key=True, default=generate_cuid)
    document_id: Mapped[str] = mapped_column(
        "documentId", String, ForeignKey("Document.id", ondelete="CASCADE"), nullable=False
    )
    content: Mapped[str] = mapped_column(Text, nullable=False)
    qdrant_id: Mapped[str] = mapped_column("qdrantId", String, unique=True, nullable=False)
    chunk_index: Mapped[int] = mapped_column("chunkIndex", Integer, nullable=False)
    chunk_metadata: Mapped[Optional[dict[str, Any]]] = mapped_column("metadata", JSONB, nullable=True)

    # Relationships
    document: Mapped[Document] = relationship("Document", back_populates="chunks")


# ── ChatSession ──────────────────────────────────────────────


class ChatSession(Base):
    __tablename__ = "ChatSession"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=generate_cuid)
    workspace_id: Mapped[Optional[str]] = mapped_column(
        "workspaceId", String, ForeignKey("Workspace.id", ondelete="CASCADE"), nullable=True
    )
    title: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    folder_scope: Mapped[list[str]] = mapped_column("folderScope", ARRAY(String), default=list, nullable=False)
    agent_state: Mapped[Optional[dict[str, Any]]] = mapped_column("agentState", JSONB, nullable=True)
    agent_state_encrypted: Mapped[Optional[str]] = mapped_column("agentStateEncrypted", Text, nullable=True)
    agent_status: Mapped[str] = mapped_column("agentStatus", String, default="idle", nullable=False)
    last_read_at: Mapped[Optional[datetime]] = mapped_column("lastReadAt", DateTime(timezone=True), nullable=True)
    context_summary: Mapped[Optional[str]] = mapped_column("contextSummary", Text, nullable=True)
    context_summary_up_to: Mapped[Optional[str]] = mapped_column("contextSummaryUpTo", String, nullable=True)
    last_input_tokens: Mapped[Optional[int]] = mapped_column("lastInputTokens", Integer, nullable=True)
    linux_user: Mapped[Optional[str]] = mapped_column("linuxUser", String, nullable=True)
    session_allow_rules: Mapped[Optional[dict[str, Any]]] = mapped_column("sessionAllowRules", JSONB, nullable=True)
    source: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    external_chat_id: Mapped[Optional[str]] = mapped_column("externalChatId", String, nullable=True)
    last_message_at: Mapped[datetime] = mapped_column(
        "lastMessageAt", DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        "createdAt", DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        "updatedAt", DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    # Relationships
    workspace: Mapped[Optional[Workspace]] = relationship("Workspace", back_populates="chat_sessions")
    messages: Mapped[list[ChatMessage]] = relationship(
        "ChatMessage", back_populates="session", cascade="all, delete-orphan"
    )
    sandbox_sessions: Mapped[list[SandboxSession]] = relationship(
        "SandboxSession", back_populates="chat_session", cascade="all, delete-orphan"
    )
    tool_approvals: Mapped[list[ToolApproval]] = relationship(
        "ToolApproval", back_populates="chat_session", cascade="all, delete-orphan"
    )


# ── Channel ──────────────────────────────────────────────────


class Channel(Base):
    __tablename__ = "Channel"
    __table_args__ = (
        UniqueConstraint("workspaceId", "type", name="Channel_workspaceId_type_key"),
        Index("Channel_workspaceId_idx", "workspaceId"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=generate_cuid)
    workspace_id: Mapped[str] = mapped_column(
        "workspaceId", String, ForeignKey("Workspace.id", ondelete="CASCADE"), nullable=False
    )
    type: Mapped[str] = mapped_column(String, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    config: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        "createdAt", DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        "updatedAt", DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    # Relationships
    workspace: Mapped[Workspace] = relationship("Workspace", back_populates="channels")


# ── ChatMessage ──────────────────────────────────────────────


class ChatMessage(Base):
    __tablename__ = "ChatMessage"
    __table_args__ = (Index("ChatMessage_sessionId_idx", "sessionId"),)

    id: Mapped[str] = mapped_column(String, primary_key=True, default=generate_cuid)
    session_id: Mapped[str] = mapped_column(
        "sessionId", String, ForeignKey("ChatSession.id", ondelete="CASCADE"), nullable=False
    )
    role: Mapped[str] = mapped_column(String, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    sources: Mapped[Optional[dict[str, Any]]] = mapped_column(JSONB, nullable=True)
    tool_calls: Mapped[Optional[dict[str, Any]]] = mapped_column("toolCalls", JSONB, nullable=True)
    content_blocks: Mapped[Optional[dict[str, Any]]] = mapped_column("contentBlocks", JSONB, nullable=True)
    attachments: Mapped[Optional[dict[str, Any]]] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        "createdAt", DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    # Relationships
    session: Mapped[ChatSession] = relationship("ChatSession", back_populates="messages")
    tool_executions: Mapped[list[ToolExecution]] = relationship("ToolExecution", back_populates="chat_message")


# ── AppSettings ──────────────────────────────────────────────


class AppSettings(Base):
    __tablename__ = "AppSettings"

    id: Mapped[str] = mapped_column(String, primary_key=True, default="singleton")
    ai_provider: Mapped[str] = mapped_column("aiProvider", String, default="openai", nullable=False)
    ai_model: Mapped[Optional[str]] = mapped_column("aiModel", String, nullable=True)
    medium_model: Mapped[Optional[str]] = mapped_column("mediumModel", String, nullable=True)
    light_model: Mapped[Optional[str]] = mapped_column("lightModel", String, nullable=True)
    explore_model: Mapped[Optional[str]] = mapped_column("exploreModel", String, nullable=True)
    execute_model: Mapped[Optional[str]] = mapped_column("executeModel", String, nullable=True)
    title_model: Mapped[Optional[str]] = mapped_column("titleModel", String, nullable=True)
    compact_model: Mapped[Optional[str]] = mapped_column("compactModel", String, nullable=True)
    llm_provider_overrides: Mapped[Optional[dict[str, Any]]] = mapped_column("llmProviderOverrides", JSONB, nullable=True)
    use_light_model: Mapped[bool] = mapped_column("useLightModel", Boolean, default=True, nullable=False)
    advanced_model_config: Mapped[bool] = mapped_column("advancedModelConfig", Boolean, default=False, nullable=False)
    embedding_provider: Mapped[str] = mapped_column("embeddingProvider", String, default="openai", nullable=False)
    embedding_model: Mapped[Optional[str]] = mapped_column("embeddingModel", String, nullable=True)
    openai_api_key: Mapped[Optional[str]] = mapped_column("openaiApiKey", Text, nullable=True)
    gemini_api_key: Mapped[Optional[str]] = mapped_column("geminiApiKey", Text, nullable=True)
    anthropic_api_key: Mapped[Optional[str]] = mapped_column("anthropicApiKey", Text, nullable=True)
    local_base_url: Mapped[Optional[str]] = mapped_column("localBaseUrl", String, nullable=True)
    onboarding_complete: Mapped[bool] = mapped_column("onboardingComplete", Boolean, default=False, nullable=False)
    context_limit_tokens: Mapped[int] = mapped_column("contextLimitTokens", Integer, default=30000, nullable=False)
    browser_grid_url: Mapped[Optional[str]] = mapped_column("browserGridUrl", String, nullable=True)
    browser_grid_api_key: Mapped[Optional[str]] = mapped_column("browserGridApiKey", Text, nullable=True)
    browser_grid_browser: Mapped[Optional[str]] = mapped_column("browserGridBrowser", String, nullable=True)
    browser_model: Mapped[Optional[str]] = mapped_column("browserModel", String, nullable=True)
    max_agent_iterations: Mapped[int] = mapped_column("maxAgentIterations", Integer, default=50, nullable=False)
    sub_agent_explore_max_iterations: Mapped[int] = mapped_column("subAgentExploreMaxIterations", Integer, default=50, nullable=False)
    sub_agent_analyze_max_iterations: Mapped[int] = mapped_column("subAgentAnalyzeMaxIterations", Integer, default=25, nullable=False)
    sub_agent_execute_max_iterations: Mapped[int] = mapped_column("subAgentExecuteMaxIterations", Integer, default=50, nullable=False)
    dismissed_update_version: Mapped[Optional[str]] = mapped_column("dismissedUpdateVersion", String, nullable=True)
    timezone: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        "updatedAt", DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


# ── AppUpdateRun ─────────────────────────────────────────────


class AppUpdateRun(Base):
    __tablename__ = "AppUpdateRun"
    __table_args__ = (
        Index("AppUpdateRun_status_idx", "status"),
        Index("AppUpdateRun_targetVersion_idx", "targetVersion"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=generate_cuid)
    status: Mapped[str] = mapped_column(String, default="pending", nullable=False)
    phase: Mapped[str] = mapped_column(String, default="pending", nullable=False)
    current_version: Mapped[Optional[str]] = mapped_column("currentVersion", String, nullable=True)
    target_version: Mapped[str] = mapped_column("targetVersion", String, nullable=False)
    target_release_name: Mapped[Optional[str]] = mapped_column("targetReleaseName", String, nullable=True)
    target_release_url: Mapped[Optional[str]] = mapped_column("targetReleaseUrl", String, nullable=True)
    target_published_at: Mapped[Optional[datetime]] = mapped_column("targetPublishedAt", DateTime(timezone=True), nullable=True)
    target_release_notes: Mapped[Optional[str]] = mapped_column("targetReleaseNotes", Text, nullable=True)
    phase_message: Mapped[Optional[str]] = mapped_column("phaseMessage", String, nullable=True)
    progress: Mapped[Optional[dict[str, Any]]] = mapped_column(JSONB, nullable=True)
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    started_at: Mapped[Optional[datetime]] = mapped_column("startedAt", DateTime(timezone=True), nullable=True)
    completed_at: Mapped[Optional[datetime]] = mapped_column("completedAt", DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        "createdAt", DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        "updatedAt", DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


# ── Capability ───────────────────────────────────────────────


class Capability(Base):
    __tablename__ = "Capability"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=generate_cuid)
    slug: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    icon: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    category: Mapped[str] = mapped_column(String, default="general", nullable=False)
    version: Mapped[str] = mapped_column(String, default="1.0.0", nullable=False)
    tool_definitions: Mapped[dict[str, Any]] = mapped_column("toolDefinitions", JSONB, nullable=False)
    system_prompt: Mapped[str] = mapped_column("systemPrompt", Text, nullable=False)
    docker_image: Mapped[Optional[str]] = mapped_column("dockerImage", String, nullable=True)
    packages: Mapped[list[str]] = mapped_column(ARRAY(String), default=list, nullable=False)
    network_access: Mapped[bool] = mapped_column("networkAccess", Boolean, default=False, nullable=False)
    config_schema: Mapped[Optional[dict[str, Any]]] = mapped_column("configSchema", JSONB, nullable=True)
    auth_type: Mapped[Optional[str]] = mapped_column("authType", String, nullable=True)
    builtin: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    global_config: Mapped[Optional[dict[str, Any]]] = mapped_column("globalConfig", JSONB, nullable=True)
    skill_type: Mapped[Optional[str]] = mapped_column("skillType", String, nullable=True)
    installation_script: Mapped[Optional[str]] = mapped_column("installationScript", Text, nullable=True)
    source: Mapped[str] = mapped_column(String, default="builtin", nullable=False)
    skill_file_key: Mapped[Optional[str]] = mapped_column("skillFileKey", String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        "createdAt", DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        "updatedAt", DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    # Relationships
    workspace_capabilities: Mapped[list[WorkspaceCapability]] = relationship(
        "WorkspaceCapability", back_populates="capability", cascade="all, delete-orphan"
    )


# ── WorkspaceCapability ──────────────────────────────────────


class WorkspaceCapability(Base):
    __tablename__ = "WorkspaceCapability"
    __table_args__ = (
        UniqueConstraint("workspaceId", "capabilityId", name="WorkspaceCapability_workspaceId_capabilityId_key"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=generate_cuid)
    workspace_id: Mapped[str] = mapped_column(
        "workspaceId", String, ForeignKey("Workspace.id", ondelete="CASCADE"), nullable=False
    )
    capability_id: Mapped[str] = mapped_column(
        "capabilityId", String, ForeignKey("Capability.id", ondelete="CASCADE"), nullable=False
    )
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    config: Mapped[Optional[dict[str, Any]]] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        "createdAt", DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    # Relationships
    workspace: Mapped[Workspace] = relationship("Workspace", back_populates="workspace_capabilities")
    capability: Mapped[Capability] = relationship("Capability", back_populates="workspace_capabilities")


# ── SandboxSession ───────────────────────────────────────────


class SandboxSession(Base):
    __tablename__ = "SandboxSession"
    __table_args__ = (Index("SandboxSession_chatSessionId_idx", "chatSessionId"),)

    id: Mapped[str] = mapped_column(String, primary_key=True, default=generate_cuid)
    workspace_id: Mapped[Optional[str]] = mapped_column(
        "workspaceId", String, ForeignKey("Workspace.id", ondelete="CASCADE"), nullable=True
    )
    chat_session_id: Mapped[str] = mapped_column(
        "chatSessionId", String, ForeignKey("ChatSession.id", ondelete="CASCADE"), nullable=False
    )
    container_id: Mapped[Optional[str]] = mapped_column("containerId", String, nullable=True)
    status: Mapped[str] = mapped_column(String, default="pending", nullable=False)
    image: Mapped[str] = mapped_column(String, nullable=False)
    started_at: Mapped[Optional[datetime]] = mapped_column("startedAt", DateTime(timezone=True), nullable=True)
    stopped_at: Mapped[Optional[datetime]] = mapped_column("stoppedAt", DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        "createdAt", DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    # Relationships
    workspace: Mapped[Optional[Workspace]] = relationship("Workspace", back_populates="sandbox_sessions")
    chat_session: Mapped[ChatSession] = relationship("ChatSession", back_populates="sandbox_sessions")
    executions: Mapped[list[ToolExecution]] = relationship("ToolExecution", back_populates="sandbox_session")


# ── ToolExecution ────────────────────────────────────────────


class ToolExecution(Base):
    __tablename__ = "ToolExecution"
    __table_args__ = (Index("ToolExecution_chatMessageId_idx", "chatMessageId"),)

    id: Mapped[str] = mapped_column(String, primary_key=True, default=generate_cuid)
    sandbox_session_id: Mapped[Optional[str]] = mapped_column(
        "sandboxSessionId", String, ForeignKey("SandboxSession.id", ondelete="SET NULL"), nullable=True
    )
    chat_message_id: Mapped[Optional[str]] = mapped_column(
        "chatMessageId", String, ForeignKey("ChatMessage.id", ondelete="SET NULL"), nullable=True
    )
    capability_slug: Mapped[str] = mapped_column("capabilitySlug", String, nullable=False)
    tool_name: Mapped[str] = mapped_column("toolName", String, nullable=False)
    input: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    output: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    screenshot: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    exit_code: Mapped[Optional[int]] = mapped_column("exitCode", Integer, nullable=True)
    duration_ms: Mapped[Optional[int]] = mapped_column("durationMs", Integer, nullable=True)
    status: Mapped[str] = mapped_column(String, default="pending", nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        "createdAt", DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    # Relationships
    sandbox_session: Mapped[Optional[SandboxSession]] = relationship("SandboxSession", back_populates="executions")
    chat_message: Mapped[Optional[ChatMessage]] = relationship("ChatMessage", back_populates="tool_executions")


# ── ToolApproval ─────────────────────────────────────────────


class ToolApproval(Base):
    __tablename__ = "ToolApproval"
    __table_args__ = (Index("ToolApproval_chatSessionId_idx", "chatSessionId"),)

    id: Mapped[str] = mapped_column(String, primary_key=True, default=generate_cuid)
    chat_session_id: Mapped[str] = mapped_column(
        "chatSessionId", String, ForeignKey("ChatSession.id", ondelete="CASCADE"), nullable=False
    )
    tool_name: Mapped[str] = mapped_column("toolName", String, nullable=False)
    capability_slug: Mapped[str] = mapped_column("capabilitySlug", String, nullable=False)
    input: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    tool_call_id: Mapped[str] = mapped_column("toolCallId", String, nullable=False)
    status: Mapped[str] = mapped_column(String, default="pending", nullable=False)
    decided_at: Mapped[Optional[datetime]] = mapped_column("decidedAt", DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        "createdAt", DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    # Relationships
    chat_session: Mapped[ChatSession] = relationship("ChatSession", back_populates="tool_approvals")


# ── GlobalSettings ───────────────────────────────────────────


class GlobalSettings(Base):
    __tablename__ = "GlobalSettings"

    id: Mapped[str] = mapped_column(String, primary_key=True, default="singleton")
    auto_approve_rules: Mapped[Optional[dict[str, Any]]] = mapped_column("autoApproveRules", JSONB, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        "updatedAt", DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


# ── TokenUsage ───────────────────────────────────────────────


class TokenUsage(Base):
    __tablename__ = "TokenUsage"
    __table_args__ = (
        Index("TokenUsage_date_idx", "date"),
        Index("TokenUsage_provider_idx", "provider"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=generate_cuid)
    provider: Mapped[str] = mapped_column(String, nullable=False)
    model: Mapped[str] = mapped_column(String, nullable=False)
    input_tokens: Mapped[int] = mapped_column("inputTokens", Integer, default=0, nullable=False)
    output_tokens: Mapped[int] = mapped_column("outputTokens", Integer, default=0, nullable=False)
    total_tokens: Mapped[int] = mapped_column("totalTokens", Integer, default=0, nullable=False)
    session_id: Mapped[Optional[str]] = mapped_column("sessionId", String, nullable=True)
    date: Mapped[str] = mapped_column(String, nullable=False)  # YYYY-MM-DD
    created_at: Mapped[datetime] = mapped_column(
        "createdAt", DateTime(timezone=True), server_default=func.now(), nullable=False
    )


# ── CronJob ──────────────────────────────────────────────────


class CronJob(Base):
    __tablename__ = "CronJob"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=generate_cuid)
    name: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    schedule: Mapped[str] = mapped_column(String, nullable=False)
    type: Mapped[str] = mapped_column(String, default="internal", nullable=False)
    handler: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    prompt: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    workspace_id: Mapped[Optional[str]] = mapped_column("workspaceId", String, nullable=True)
    session_id: Mapped[Optional[str]] = mapped_column("sessionId", String, nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    builtin: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    last_run_at: Mapped[Optional[datetime]] = mapped_column("lastRunAt", DateTime(timezone=True), nullable=True)
    last_run_status: Mapped[Optional[str]] = mapped_column("lastRunStatus", String, nullable=True)
    last_run_error: Mapped[Optional[str]] = mapped_column("lastRunError", Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        "createdAt", DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        "updatedAt", DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
