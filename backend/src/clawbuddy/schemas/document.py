"""Document schemas.

Replaces: packages/shared/src/schemas/document.schema.ts
         + packages/shared/src/types/index.ts (enums)
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, Field


class DocumentStatus(StrEnum):
    """Document processing status."""

    PENDING = "PENDING"
    PROCESSING = "PROCESSING"
    READY = "READY"
    FAILED = "FAILED"


class DocumentType(StrEnum):
    """Supported document types."""

    MARKDOWN = "MARKDOWN"
    PDF = "PDF"
    DOCX = "DOCX"
    TXT = "TXT"
    HTML = "HTML"


class CreateDocumentInput(BaseModel):
    """Create document request body."""

    title: str = Field(min_length=1, max_length=200, description="Document title is required")
    folder_id: str | None = Field(default=None, alias="folderId")
    type: DocumentType
    content: str | None = None

    model_config = {"populate_by_name": True}
