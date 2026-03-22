"""Ingestion worker — ARQ background task for document processing.

Replaces: apps/api/src/workers/ingestion.worker.ts (BullMQ)

Pipeline:
1. Download content from MinIO or load inline
2. Split into chunks
3. Embed chunks in batches
4. Store chunks in PostgreSQL + vectors in Qdrant
5. Update document status to READY
"""

from __future__ import annotations

import uuid
from typing import Any

from loguru import logger

from clawbuddy.constants import CHUNK_OVERLAP, CHUNK_SIZE


async def process_document(
    ctx: dict[str, Any],
    document_id: str,
    file_url: str | None = None,
) -> None:
    """ARQ task: process a document through the ingestion pipeline."""
    from clawbuddy.db.models import Document, DocumentChunk
    from clawbuddy.db.session import async_session_factory
    from clawbuddy.lib.sanitize import sanitize_surrogates
    from clawbuddy.services.chunking import chunking_service
    from clawbuddy.services.embedding import embedding_service
    from clawbuddy.services.search import search_service
    from clawbuddy.services.storage import storage_service
    from sqlalchemy import select

    logger.info(f"[Ingestion] Processing document {document_id}")

    async with async_session_factory() as db:
        # Update status to PROCESSING
        result = await db.execute(
            select(Document).where(Document.id == document_id)
        )
        doc = result.scalar_one()
        doc.status = "PROCESSING"
        doc.processing_step = "downloading"
        doc.processing_pct = 0
        await db.commit()

        try:
            # 1. Get text content — from MinIO or inline document content
            if file_url:
                body = await storage_service.download(file_url)
                chunks_raw: list[bytes] = []
                if hasattr(body, "read"):
                    data = await body.read()
                    chunks_raw.append(
                        data if isinstance(data, bytes) else data.encode()
                    )
                elif hasattr(body, "__aiter__"):
                    async for chunk in body:
                        if isinstance(chunk, bytes):
                            chunks_raw.append(chunk)
                        else:
                            chunks_raw.append(chunk.encode())
                else:
                    chunks_raw.append(str(body).encode())
                text = b"".join(chunks_raw).decode("utf-8")
            else:
                # Inline content (e.g. from save_document tool)
                await db.refresh(doc)
                text = doc.content or ""

            # Strip characters that break JSON serialization
            text = sanitize_surrogates(text)

            if not text.strip():
                raise ValueError("Empty document content")

            # 2. Split into chunks
            doc.processing_step = "chunking"
            doc.processing_pct = 15
            await db.commit()

            text_chunks = chunking_service.split_text(
                text, chunk_size=CHUNK_SIZE, overlap=CHUNK_OVERLAP
            )
            logger.info(
                f"[Ingestion] Document {document_id}: {len(text_chunks)} chunks"
            )

            # 3. Ensure Qdrant collection exists
            dimensions = await embedding_service.get_embedding_dimensions()
            await search_service.ensure_collection(dimensions)

            # 4. Generate embeddings and store
            doc.processing_step = "embedding"
            doc.processing_pct = 25
            await db.commit()

            workspace_id = doc.workspace_id
            batch_size = 20
            total_stored = 0

            for i in range(0, len(text_chunks), batch_size):
                batch = text_chunks[i : i + batch_size]
                embeddings = await embedding_service.embed_batch(batch)

                for j, chunk_text in enumerate(batch):
                    qdrant_id = str(uuid.uuid4())
                    chunk_index = i + j

                    safe_content = sanitize_surrogates(chunk_text)

                    # Store in PostgreSQL
                    chunk = DocumentChunk(
                        document_id=document_id,
                        content=safe_content,
                        qdrant_id=qdrant_id,
                        chunk_index=chunk_index,
                        metadata={"workspaceId": workspace_id},
                    )
                    db.add(chunk)
                    await db.flush()

                    # Store vector in Qdrant
                    await search_service.upsert(
                        qdrant_id,
                        embeddings[j],
                        {
                            "documentId": document_id,
                            "chunkId": chunk.id,
                            "chunkIndex": chunk_index,
                            "workspaceId": workspace_id,
                            "content": safe_content[:200],
                        },
                    )

                    total_stored += 1

                # Update progress
                pct = min(25 + int(total_stored / len(text_chunks) * 70), 95)
                doc.processing_step = "indexing"
                doc.processing_pct = pct
                await db.commit()

            # 5. Update document status to READY
            doc.status = "READY"
            doc.content = text[:10000]  # store preview
            doc.chunk_count = total_stored
            doc.processing_step = None
            doc.processing_pct = 100
            await db.commit()

            logger.info(
                f"[Ingestion] Document {document_id} ready: "
                f"{total_stored} chunks indexed"
            )

        except Exception as exc:
            logger.error(
                f"[Ingestion] Failed for document {document_id}: {exc}"
            )
            doc.status = "FAILED"
            doc.processing_step = None
            doc.processing_pct = None
            await db.commit()
            raise
