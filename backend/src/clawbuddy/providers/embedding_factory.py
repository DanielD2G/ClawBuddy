"""Embedding factory — creates LangChain Embeddings instances from provider+model.

Replaces: apps/api/src/providers/ (openai_embeddings, gemini_embeddings, local_embeddings)
"""

from __future__ import annotations

from typing import Any

from langchain_core.embeddings import Embeddings

from clawbuddy.services.settings_service import settings_service


async def create_embeddings(
    *,
    provider: str | None = None,
    model: str | None = None,
    api_key: str | None = None,
) -> Embeddings:
    """Create a LangChain Embeddings instance for the configured provider.

    If *provider* and *model* are not given, they are resolved from settings.
    """
    if provider is None:
        provider = await settings_service.get_embedding_provider()
    if model is None:
        model = await settings_service.get_embedding_model()
    if api_key is None:
        api_key = await settings_service.get_api_key(provider)

    if provider == "openai":
        return _create_openai_embeddings(model, api_key)
    elif provider == "gemini":
        return _create_gemini_embeddings(model, api_key)
    elif provider == "local":
        base_url = await settings_service.get_local_base_url()
        return _create_local_embeddings(model, base_url, api_key)
    else:
        raise ValueError(f"Unknown embedding provider: {provider}")


def _create_openai_embeddings(model: str, api_key: str | None) -> Embeddings:
    from langchain_openai import OpenAIEmbeddings

    return OpenAIEmbeddings(model=model, api_key=api_key)


def _create_gemini_embeddings(model: str, api_key: str | None) -> Embeddings:
    from langchain_google_genai import GoogleGenerativeAIEmbeddings

    return GoogleGenerativeAIEmbeddings(model=model, google_api_key=api_key)


def _create_local_embeddings(
    model: str, base_url: str | None, api_key: str | None
) -> Embeddings:
    from langchain_openai import OpenAIEmbeddings

    return OpenAIEmbeddings(
        model=model,
        base_url=base_url,
        api_key=api_key or "not-needed",
    )
