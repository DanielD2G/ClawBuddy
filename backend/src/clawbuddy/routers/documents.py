"""Document routes.

Replaces: apps/api/src/routes/documents.ts
"""

from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, Depends, Request, UploadFile, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from clawbuddy.db.models import Document, DocumentChunk, Workspace
from clawbuddy.db.session import get_db
from clawbuddy.lib.responses import fail, ok
from clawbuddy.lib.sanitize import sanitize_file_name
from clawbuddy.schemas.document import CreateDocumentInput
from clawbuddy.services.storage import storage_service

router = APIRouter(tags=["Documents"])

_EXT_TYPE_MAP: dict[str, str] = {
    "PDF": "PDF",
    "DOCX": "DOCX",
    "MD": "MARKDOWN",
    "TXT": "TXT",
    "HTML": "HTML",
}


@router.get("/documents")
async def list_all_documents(db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    result = await db.execute(
        select(Document)
        .options(selectinload(Document.workspace))
        .order_by(Document.created_at.desc())
    )
    documents = result.scalars().all()
    return ok(documents)


@router.get("/workspaces/{workspace_id}/documents")
async def list_workspace_documents(
    workspace_id: str,
    folderId: str | None = None,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    stmt = select(Document).where(Document.workspace_id == workspace_id)
    if folderId is not None:
        folder_val = None if folderId == "null" else folderId
        stmt = stmt.where(Document.folder_id == folder_val)
    stmt = stmt.order_by(Document.created_at.desc())
    result = await db.execute(stmt)
    return ok(list(result.scalars().all()))


@router.post("/workspaces/{workspace_id}/documents", status_code=status.HTTP_201_CREATED)
async def create_document(
    workspace_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    content_type = request.headers.get("content-type", "")

    if "multipart/form-data" in content_type:
        form = await request.form()
        file: UploadFile | None = form.get("file")  # type: ignore[assignment]
        folder_id = form.get("folderId") or None

        if not file or not file.filename:
            return fail("No file provided", status_code=400)

        ext = file.filename.rsplit(".", 1)[-1].upper() if "." in file.filename else "TXT"
        doc_type = _EXT_TYPE_MAP.get(ext, "TXT")

        key = f"documents/{workspace_id}/{int(time.time() * 1000)}-{sanitize_file_name(file.filename)}"
        contents = await file.read()
        await storage_service.upload(key, contents, file.content_type or "application/octet-stream")

        doc = Document(
            title=file.filename,
            workspace_id=workspace_id,
            type=doc_type,
            status="PENDING",
            file_url=key,
            folder_id=folder_id,
        )
        db.add(doc)
        await db.commit()
        await db.refresh(doc)

        # Enqueue ingestion
        from clawbuddy.services.ingestion import ingestion_service

        await ingestion_service.enqueue(doc.id, key)

        return ok(doc)

    # JSON body — inline content
    body = await request.json()
    data = CreateDocumentInput.model_validate(body)
    doc = Document(
        title=data.title,
        workspace_id=workspace_id,
        type=data.type.value,
        status="READY",
        content=data.content,
        folder_id=data.folder_id,
    )
    db.add(doc)
    await db.commit()
    await db.refresh(doc)
    return ok(doc)


@router.get("/workspaces/{workspace_id}/documents/{doc_id}")
async def get_document(
    workspace_id: str,
    doc_id: str,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    result = await db.execute(select(Document).where(Document.id == doc_id))
    doc = result.scalar_one_or_none()
    if not doc:
        return fail("Document not found", status_code=404)
    return ok(doc)


@router.patch("/workspaces/{workspace_id}/documents/{doc_id}")
async def update_document(
    workspace_id: str,
    doc_id: str,
    body: dict[str, Any],
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    result = await db.execute(select(Document).where(Document.id == doc_id))
    doc = result.scalar_one()
    doc.folder_id = body.get("folderId")
    await db.commit()
    await db.refresh(doc)
    return ok(doc)


@router.post("/workspaces/{workspace_id}/documents/{doc_id}/reingest")
async def reingest_document(
    workspace_id: str,
    doc_id: str,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    result = await db.execute(select(Document).where(Document.id == doc_id))
    doc = result.scalar_one_or_none()
    if not doc:
        return fail("Document not found", status_code=404)

    # Delete existing chunks
    await db.execute(
        select(DocumentChunk).where(DocumentChunk.document_id == doc_id)
    )
    from sqlalchemy import delete

    await db.execute(delete(DocumentChunk).where(DocumentChunk.document_id == doc_id))

    # Reset status
    doc.status = "PENDING"
    doc.processing_step = None
    doc.processing_pct = 0
    doc.chunk_count = 0
    await db.commit()

    from clawbuddy.services.ingestion import ingestion_service

    await ingestion_service.enqueue(doc_id, doc.file_url)

    return ok(None)


@router.delete("/workspaces/{workspace_id}/documents/{doc_id}")
async def delete_document(
    workspace_id: str,
    doc_id: str,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    result = await db.execute(select(Document).where(Document.id == doc_id))
    doc = result.scalar_one()
    await db.delete(doc)
    await db.commit()
    return ok({"id": doc_id})
