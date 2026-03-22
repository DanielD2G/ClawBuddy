"""LangChain-based LLM and embedding provider factories.

Replaces: apps/api/src/providers/ (all individual provider files consolidated here).
"""

from __future__ import annotations

from clawbuddy.providers.embedding_factory import create_embeddings
from clawbuddy.providers.llm_factory import create_chat_model

__all__ = ["create_chat_model", "create_embeddings"]
