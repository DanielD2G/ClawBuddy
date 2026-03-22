"""Text chunking service.

Replaces: apps/api/src/services/chunking.service.ts
"""

from __future__ import annotations

from clawbuddy.constants import CHUNK_OVERLAP, CHUNK_SIZE


class ChunkingService:
    """Split text into overlapping chunks for embedding."""

    def split_text(
        self,
        text: str,
        *,
        chunk_size: int = CHUNK_SIZE,
        overlap: int = CHUNK_OVERLAP,
    ) -> list[str]:
        """Split *text* into chunks of *chunk_size* characters with *overlap*.

        Returns a list of strings, each at most *chunk_size* characters long.
        """
        chunks: list[str] = []
        start = 0
        while start < len(text):
            chunks.append(text[start : start + chunk_size])
            start += chunk_size - overlap
        return chunks


chunking_service = ChunkingService()
