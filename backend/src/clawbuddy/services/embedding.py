"""Embedding service.

Replaces: apps/api/src/services/embedding.service.ts
Uses LangChain Embeddings under the hood.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    pass

_dimensions_cache: int | None = None
_EMPTY_EMBEDDING_PLACEHOLDER = "[empty]"


class EmbeddingService:
    """High-level embedding API backed by LangChain embedding providers."""

    @staticmethod
    def _normalize_text(text: str) -> str:
        normalized = text.strip()
        return normalized if normalized else _EMPTY_EMBEDDING_PLACEHOLDER

    async def embed(self, text: str) -> list[float]:
        """Embed a single text string."""
        from clawbuddy.providers import create_embeddings

        embeddings = await create_embeddings()
        result = await embeddings.aembed_query(self._normalize_text(text))
        return result

    async def embed_batch(self, texts: list[str]) -> list[list[float]]:
        """Embed a batch of texts."""
        from clawbuddy.providers import create_embeddings

        embeddings = await create_embeddings()
        return await embeddings.aembed_documents(
            [self._normalize_text(text) for text in texts]
        )

    async def get_embedding_dimensions(self) -> int:
        """Probe the embedding model to determine vector dimensions (cached)."""
        global _dimensions_cache
        if _dimensions_cache is not None:
            return _dimensions_cache
        vector = await self.embed("dimension probe")
        _dimensions_cache = len(vector)
        return _dimensions_cache


embedding_service = EmbeddingService()
