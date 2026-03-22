"""LLM factory — creates LangChain BaseChatModel instances from provider+model.

Replaces: apps/api/src/providers/ (claude_llm, openai_llm, gemini_llm, openai_compatible, local_llm)
"""

from __future__ import annotations

from typing import Any

from langchain_core.language_models import BaseChatModel

from clawbuddy.config import supports_vision
from clawbuddy.lib.llm_resolver import LLMRole
from clawbuddy.services.settings_service import settings_service


async def create_chat_model(
    *,
    role: LLMRole = "primary",
    provider: str | None = None,
    model: str | None = None,
    api_key: str | None = None,
    temperature: float | None = None,
    max_tokens: int | None = None,
    **kwargs: Any,
) -> BaseChatModel:
    """Create a LangChain chat model for the given role/provider/model.

    If *provider* and *model* are not given, they are resolved from the settings
    for the specified *role*.
    """
    if provider is None or model is None:
        resolved = await settings_service.get_resolved_llm_role(role)
        provider = provider or resolved["provider"]
        model = model or resolved["model"]

    if api_key is None:
        api_key = await settings_service.get_api_key(provider)

    if not model:
        model = (await settings_service.get_ai_model())

    if provider == "openai":
        return _create_openai(model, api_key, temperature, max_tokens, **kwargs)
    elif provider == "claude":
        return _create_anthropic(model, api_key, temperature, max_tokens, **kwargs)
    elif provider == "gemini":
        return _create_gemini(model, api_key, temperature, max_tokens, **kwargs)
    elif provider == "local":
        base_url = await settings_service.get_local_base_url()
        return _create_openai_compatible(model, base_url, api_key, temperature, max_tokens, **kwargs)
    else:
        raise ValueError(f"Unknown LLM provider: {provider}")


def _create_openai(
    model: str,
    api_key: str | None,
    temperature: float | None,
    max_tokens: int | None,
    **kwargs: Any,
) -> BaseChatModel:
    from langchain_openai import ChatOpenAI

    # Newer OpenAI models use max_completion_tokens instead of max_tokens
    model_kwargs: dict[str, Any] = {}
    if temperature is not None:
        model_kwargs["temperature"] = temperature
    if max_tokens is not None:
        if any(model.startswith(p) for p in ("o1", "o3", "o4")):
            model_kwargs["max_completion_tokens"] = max_tokens
        else:
            model_kwargs["max_tokens"] = max_tokens

    return ChatOpenAI(
        model=model,
        api_key=api_key,
        **model_kwargs,
        **kwargs,
    )


def _create_anthropic(
    model: str,
    api_key: str | None,
    temperature: float | None,
    max_tokens: int | None,
    **kwargs: Any,
) -> BaseChatModel:
    from clawbuddy.constants import CLAUDE_DEFAULT_MAX_TOKENS
    from langchain_anthropic import ChatAnthropic

    model_kwargs: dict[str, Any] = {
        "max_tokens": max_tokens or CLAUDE_DEFAULT_MAX_TOKENS,
    }
    if temperature is not None:
        model_kwargs["temperature"] = temperature

    return ChatAnthropic(
        model=model,
        api_key=api_key,
        **model_kwargs,
        **kwargs,
    )


def _create_gemini(
    model: str,
    api_key: str | None,
    temperature: float | None,
    max_tokens: int | None,
    **kwargs: Any,
) -> BaseChatModel:
    from langchain_google_genai import ChatGoogleGenerativeAI

    model_kwargs: dict[str, Any] = {}
    if temperature is not None:
        model_kwargs["temperature"] = temperature
    if max_tokens is not None:
        model_kwargs["max_output_tokens"] = max_tokens

    return ChatGoogleGenerativeAI(
        model=model,
        google_api_key=api_key,
        **model_kwargs,
        **kwargs,
    )


def _create_openai_compatible(
    model: str,
    base_url: str | None,
    api_key: str | None,
    temperature: float | None,
    max_tokens: int | None,
    **kwargs: Any,
) -> BaseChatModel:
    from langchain_openai import ChatOpenAI

    model_kwargs: dict[str, Any] = {}
    if temperature is not None:
        model_kwargs["temperature"] = temperature
    if max_tokens is not None:
        model_kwargs["max_tokens"] = max_tokens

    return ChatOpenAI(
        model=model,
        base_url=base_url,
        api_key=api_key or "not-needed",
        **model_kwargs,
        **kwargs,
    )
