"""Vector search service backed by Qdrant.

Replaces: apps/api/src/services/search.service.ts
"""

from __future__ import annotations

from typing import Any

from loguru import logger
from qdrant_client.models import Distance, FieldCondition, Filter, MatchValue, VectorParams

from clawbuddy.constants import QDRANT_COLLECTION_NAME
from clawbuddy.lib.qdrant import qdrant


class SearchService:
    """Qdrant-backed vector search."""

    async def search(
        self,
        query_vector: list[float],
        *,
        limit: int = 10,
        workspace_id: str | None = None,
        document_ids: list[str] | None = None,
    ) -> list[Any]:
        """Search for similar vectors in Qdrant."""
        must: list[Any] = []
        if workspace_id:
            must.append(
                FieldCondition(key="workspaceId", match=MatchValue(value=workspace_id))
            )
        if document_ids:
            # OR across multiple document IDs
            should = [
                FieldCondition(key="documentId", match=MatchValue(value=doc_id))
                for doc_id in document_ids
            ]
            must.append(Filter(should=should))

        search_filter = Filter(must=must) if must else None

        response = await qdrant.query_points(
            collection_name=QDRANT_COLLECTION_NAME,
            query=query_vector,
            limit=limit,
            query_filter=search_filter,
            with_payload=True,
        )
        return list(response.points)

    async def upsert(
        self,
        point_id: str,
        vector: list[float],
        payload: dict[str, Any],
    ) -> None:
        """Upsert a single point into Qdrant."""
        from qdrant_client.models import PointStruct

        await qdrant.upsert(
            collection_name=QDRANT_COLLECTION_NAME,
            points=[PointStruct(id=point_id, vector=vector, payload=payload)],
        )

    async def ensure_collection(self, dimensions: int) -> None:
        """Ensure the Qdrant collection exists with the correct dimensions.

        If the collection exists with a different dimension, it is recreated.
        """
        collections = await qdrant.get_collections()
        exists = any(
            c.name == QDRANT_COLLECTION_NAME for c in collections.collections
        )

        if exists:
            info = await qdrant.get_collection(QDRANT_COLLECTION_NAME)
            vectors_config = info.config.params.vectors
            if isinstance(vectors_config, VectorParams):
                current_size = vectors_config.size
            else:
                # Named vectors — get default
                current_size = getattr(vectors_config, "size", 0)

            if current_size != dimensions:
                logger.warning(
                    f"[Search] Collection dimension mismatch ({current_size} vs {dimensions}). "
                    f"Recreating collection."
                )
                await qdrant.delete_collection(QDRANT_COLLECTION_NAME)
                await qdrant.create_collection(
                    collection_name=QDRANT_COLLECTION_NAME,
                    vectors_config=VectorParams(size=dimensions, distance=Distance.COSINE),
                )
        else:
            await qdrant.create_collection(
                collection_name=QDRANT_COLLECTION_NAME,
                vectors_config=VectorParams(size=dimensions, distance=Distance.COSINE),
            )


search_service = SearchService()
