"""Qdrant vector database client.

Replaces: apps/api/src/lib/qdrant.ts
"""

from __future__ import annotations

from qdrant_client import AsyncQdrantClient

from clawbuddy.settings import settings

qdrant: AsyncQdrantClient = AsyncQdrantClient(url=settings.QDRANT_URL)
