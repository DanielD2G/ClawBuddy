"""Chat schemas.

Replaces: packages/shared/src/schemas/chat.schema.ts
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class ChatAttachment(BaseModel):
    """File attachment in a chat message."""

    name: str
    size: int
    type: str
    storage_key: str = Field(alias="storageKey")
    url: str

    model_config = {"populate_by_name": True}


class SendChatMessageInput(BaseModel):
    """Send chat message request body."""

    content: str = Field(min_length=1, description="content is required")
    session_id: str | None = Field(default=None, alias="sessionId")
    workspace_id: str | None = Field(default=None, alias="workspaceId")
    document_ids: list[str] | None = Field(default=None, alias="documentIds")
    attachments: list[ChatAttachment] | None = None

    model_config = {"populate_by_name": True}


class CreateChatSessionInput(BaseModel):
    """Create chat session request body."""

    workspace_id: str = Field(min_length=1, alias="workspaceId", description="workspaceId is required")
    title: str | None = None

    model_config = {"populate_by_name": True}
