"""Document service.

Replaces: apps/api/src/services/document.service.ts
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from clawbuddy.db.models import Document, DocumentChunk


class DocumentService:
    """CRUD operations for documents."""

    async def list_by_workspace(
        self,
        db: AsyncSession,
        workspace_id: str,
        folder_id: str | None = ...,  # sentinel: ... means "not provided"
    ) -> list[Document]:
        stmt = select(Document).where(Document.workspace_id == workspace_id)
        if folder_id is not ...:
            stmt = stmt.where(Document.folder_id == folder_id)
        stmt = stmt.order_by(Document.created_at.desc())
        result = await db.execute(stmt)
        return list(result.scalars().all())

    async def create(self, db: AsyncSession, data: dict[str, Any]) -> Document:
        doc = Document(
            title=data["title"],
            workspace_id=data["workspaceId"],
            folder_id=data.get("folderId"),
            type=data.get("type", "TXT"),
            status=data.get("status", "PENDING"),
            file_url=data.get("fileUrl"),
            content=data.get("content"),
        )
        db.add(doc)
        await db.commit()
        await db.refresh(doc)
        return doc

    async def find_by_id(
        self, db: AsyncSession, doc_id: str, include_chunks: bool = False
    ) -> Document | None:
        stmt = select(Document).where(Document.id == doc_id)
        if include_chunks:
            stmt = stmt.options(selectinload(Document.chunks))
        result = await db.execute(stmt)
        return result.scalar_one_or_none()

    async def update_status(
        self,
        db: AsyncSession,
        doc_id: str,
        status: str,
        chunk_count: int | None = None,
    ) -> Document:
        result = await db.execute(select(Document).where(Document.id == doc_id))
        doc = result.scalar_one()
        doc.status = status
        if chunk_count is not None:
            doc.chunk_count = chunk_count
        await db.commit()
        await db.refresh(doc)
        return doc

    async def delete(self, db: AsyncSession, doc_id: str) -> None:
        result = await db.execute(select(Document).where(Document.id == doc_id))
        doc = result.scalar_one()
        await db.delete(doc)
        await db.commit()


document_service = DocumentService()
