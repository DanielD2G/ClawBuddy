"""Ingestion service — enqueues documents for background processing.

Replaces: apps/api/src/services/ingestion.service.ts
"""

from __future__ import annotations

from loguru import logger


class IngestionService:
    """Enqueue documents for processing via ARQ workers."""

    async def enqueue(
        self, document_id: str, file_url: str | None = None
    ) -> None:
        """Enqueue a document for ingestion processing via ARQ."""
        from arq import create_pool
        from arq.connections import RedisSettings

        from clawbuddy.settings import settings

        redis_settings = RedisSettings(
            host=settings.redis_host,
            port=settings.redis_port,
        )
        pool = await create_pool(redis_settings)
        await pool.enqueue_job(
            "process_document", document_id, file_url
        )
        await pool.close()
        logger.info(f"[Ingestion] Enqueued document {document_id}")


ingestion_service = IngestionService()
