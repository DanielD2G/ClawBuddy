"""Tool discovery service — semantic search for capabilities.

Replaces: apps/api/src/services/tool-discovery.service.ts

Indexes workspace capabilities into Qdrant for semantic similarity search.
When the agent has many capabilities available, this service enables
dynamic tool loading — only the most relevant tools are bound to the LLM
for each turn, keeping the context window lean.
"""

from __future__ import annotations

import hashlib
import uuid
from dataclasses import dataclass, field
from typing import Any

from loguru import logger
from qdrant_client.models import Distance, PointStruct, VectorParams
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from clawbuddy.constants import (
    ALWAYS_ON_CAPABILITY_SLUGS,
    TOOL_DISCOVERY_COLLECTION,
    TOOL_DISCOVERY_EMBEDDING_INSTRUCTIONS_LIMIT,
    TOOL_DISCOVERY_TOP_K,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _slug_to_uuid(slug: str) -> str:
    """Generate a deterministic UUID from a slug string.

    Qdrant requires UUID or integer IDs — not arbitrary strings.
    Uses SHA-256 hash formatted as a valid UUID v4.
    """
    h = hashlib.sha256(slug.encode()).hexdigest()
    # Format as UUID: 8-4-4-4-12, set version bits for UUID v4
    return str(uuid.UUID(
        f"{h[:8]}-{h[8:12]}-4{h[13:16]}-8{h[17:20]}-{h[20:32]}"
    ))


# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------


@dataclass
class CapabilityPayload:
    slug: str
    name: str
    description: str
    tool_definitions: list[dict[str, Any]]
    system_prompt: str
    network_access: bool
    skill_type: str | None
    category: str


@dataclass
class DiscoveredCapability:
    slug: str
    name: str
    tools: list[dict[str, Any]]
    instructions: str
    network_access: bool
    skill_type: str | None


@dataclass
class DiscoveryContext:
    system_prompt: str
    tools: list[dict[str, Any]]
    always_on_slugs: list[str]


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


class ToolDiscoveryService:
    """Semantic tool discovery using embeddings and Qdrant vector search."""

    async def index_capabilities(self, db: AsyncSession | None = None) -> None:
        """Index all capabilities into Qdrant for semantic search.

        Called on server startup after capabilities and skills are synced.
        """
        from clawbuddy.db.models import Capability as CapabilityModel
        from clawbuddy.lib.qdrant import qdrant
        from clawbuddy.services.embedding import embedding_service

        if db is None:
            from clawbuddy.db.session import async_session_factory

            async with async_session_factory() as db:
                await self._index_impl(db)
                return

        await self._index_impl(db)

    async def _index_impl(self, db: AsyncSession) -> None:
        from clawbuddy.db.models import Capability as CapabilityModel
        from clawbuddy.lib.qdrant import qdrant
        from clawbuddy.services.embedding import embedding_service

        stmt = select(CapabilityModel)
        result = await db.execute(stmt)
        capabilities = result.scalars().all()

        if not capabilities:
            return

        embedding_texts: list[str] = []
        payloads: list[dict[str, Any]] = []
        ids: list[str] = []

        for cap in capabilities:
            # Skip tool-discovery itself — it's always loaded
            if cap.slug == "tool-discovery":
                continue

            tool_defs: list[dict[str, Any]] = cap.tool_definitions or []
            tool_names = ". ".join(
                f"{t.get('name', '')}: {t.get('description', '')}"
                for t in tool_defs
            )
            instructions_truncated = (cap.system_prompt or "")[
                :TOOL_DISCOVERY_EMBEDDING_INSTRUCTIONS_LIMIT
            ]

            embedding_text = ". ".join(
                part
                for part in [
                    cap.name,
                    cap.description,
                    f"Tools: {tool_names}",
                    instructions_truncated,
                ]
                if part
            )

            embedding_texts.append(embedding_text)
            ids.append(cap.slug)
            payloads.append({
                "slug": cap.slug,
                "name": cap.name,
                "description": cap.description or "",
                "toolDefinitions": tool_defs,
                "systemPrompt": cap.system_prompt or "",
                "networkAccess": cap.network_access,
                "skillType": cap.skill_type,
                "category": cap.category,
            })

        if not embedding_texts:
            return

        # Embed all capability texts
        vectors = await embedding_service.embed_batch(embedding_texts)

        # Ensure collection exists with correct dimensions
        dimensions = len(vectors[0])
        await self._ensure_collection(dimensions)

        # Upsert all points
        points = [
            PointStruct(
                id=_slug_to_uuid(ids[i]),
                vector=vectors[i],
                payload=payloads[i],
            )
            for i in range(len(vectors))
        ]

        await qdrant.upsert(
            collection_name=TOOL_DISCOVERY_COLLECTION, points=points
        )
        logger.info(
            f"[ToolDiscovery] Indexed {len(points)} capabilities into "
            f"{TOOL_DISCOVERY_COLLECTION}: "
            + ", ".join(f"{slug} ({_slug_to_uuid(slug)})" for slug in ids)
        )

    async def _ensure_collection(self, dimensions: int) -> None:
        """Ensure the Qdrant collection exists with correct dimensions."""
        from clawbuddy.lib.qdrant import qdrant

        collections_response = await qdrant.get_collections()
        existing_names = [c.name for c in collections_response.collections]

        if TOOL_DISCOVERY_COLLECTION in existing_names:
            info = await qdrant.get_collection(TOOL_DISCOVERY_COLLECTION)
            # Extract current vector size
            vectors_config = info.config.params.vectors
            if isinstance(vectors_config, dict):
                current_size = vectors_config.get("size", 0)
            else:
                current_size = getattr(vectors_config, "size", 0)

            if current_size != dimensions:
                logger.warning(
                    f"[ToolDiscovery] Collection dimension mismatch "
                    f"({current_size} vs {dimensions}). Recreating."
                )
                await qdrant.delete_collection(TOOL_DISCOVERY_COLLECTION)
                await qdrant.create_collection(
                    collection_name=TOOL_DISCOVERY_COLLECTION,
                    vectors_config=VectorParams(
                        size=dimensions, distance=Distance.COSINE
                    ),
                )
        else:
            await qdrant.create_collection(
                collection_name=TOOL_DISCOVERY_COLLECTION,
                vectors_config=VectorParams(
                    size=dimensions, distance=Distance.COSINE
                ),
            )

    async def search(
        self,
        query: str,
        enabled_slugs: list[str],
        score_threshold: float = 0.3,
    ) -> list[DiscoveredCapability]:
        """Search for relevant capabilities based on a natural language query.

        Filters results to only include capabilities enabled for the workspace.
        """
        from clawbuddy.lib.qdrant import qdrant
        from clawbuddy.services.embedding import embedding_service

        query_vector = await embedding_service.embed(query)

        # Search with a higher limit to account for post-filtering
        response = await qdrant.query_points(
            collection_name=TOOL_DISCOVERY_COLLECTION,
            query=query_vector,
            limit=TOOL_DISCOVERY_TOP_K * 3,
            with_payload=True,
            score_threshold=score_threshold,
        )
        results = response.points

        logger.info(
            f'[ToolDiscovery] Search "{query[:80]}" returned {len(results)} results: '
            + str([
                {"slug": r.payload.get("slug"), "score": r.score}
                for r in results
                if r.payload
            ])
        )

        # Filter by enabled slugs and take top-K
        enabled_set = set(enabled_slugs)
        filtered = [
            r
            for r in results
            if r.payload and r.payload.get("slug") in enabled_set
        ]

        return [
            DiscoveredCapability(
                slug=r.payload["slug"],
                name=r.payload["name"],
                tools=r.payload.get("toolDefinitions", []),
                instructions=r.payload.get("systemPrompt", ""),
                network_access=r.payload.get("networkAccess", False),
                skill_type=r.payload.get("skillType"),
            )
            for r in filtered[:TOOL_DISCOVERY_TOP_K]
        ]

    async def list_available(
        self,
        enabled_slugs: list[str],
        db: AsyncSession | None = None,
    ) -> str:
        """List all available capabilities in compact format (for fallback).

        Returns a newline-separated list of capabilities with their tools.
        """
        from clawbuddy.db.models import Capability as CapabilityModel

        if db is None:
            from clawbuddy.db.session import async_session_factory

            async with async_session_factory() as db:
                return await self._list_available_impl(db, enabled_slugs)

        return await self._list_available_impl(db, enabled_slugs)

    async def _list_available_impl(
        self, db: AsyncSession, enabled_slugs: list[str]
    ) -> str:
        from clawbuddy.db.models import Capability as CapabilityModel

        stmt = select(CapabilityModel).where(
            CapabilityModel.slug.in_(enabled_slugs)
        )
        result = await db.execute(stmt)
        capabilities = result.scalars().all()

        lines: list[str] = []
        for cap in capabilities:
            tool_defs: list[dict[str, Any]] = cap.tool_definitions or []
            tool_names = ", ".join(t.get("name", "") for t in tool_defs)
            lines.append(
                f"- {cap.slug}: {cap.name} — {cap.description} "
                f"(tools: {tool_names})"
            )

        return "\n".join(lines)

    def build_discovery_context(
        self,
        capabilities: list[dict[str, Any]],
        mentioned_slugs: list[str] | None = None,
        timezone: str | None = None,
    ) -> DiscoveryContext:
        """Build the minimal discovery context for the agent loop.

        Only includes always-on capabilities + mentioned ones + discover_tools.
        """
        from clawbuddy.capabilities.builtin.tool_discovery import TOOL_DISCOVERY
        from clawbuddy.services.capability import capability_service

        always_on_slugs = list(ALWAYS_ON_CAPABILITY_SLUGS)
        mentioned_set = set(mentioned_slugs or [])

        # Collect capabilities that should be loaded immediately
        loaded_caps = [
            c
            for c in capabilities
            if c.get("slug") in always_on_slugs or c.get("slug") in mentioned_set
        ]

        # Build system prompt with only loaded capabilities + discovery instructions
        prompt_caps = [
            *loaded_caps,
            {
                "name": TOOL_DISCOVERY["name"],
                "systemPrompt": TOOL_DISCOVERY["systemPrompt"],
            },
        ]
        system_prompt = capability_service.build_system_prompt(
            prompt_caps, timezone
        )

        # Build tool definitions: always-on tools + mentioned tools + discover_tools
        tools: list[dict[str, Any]] = capability_service.build_tool_definitions(
            loaded_caps
        )

        # Add discover_tools (if not already loaded via always-on capabilities)
        existing_tool_names = {t.get("name") for t in tools}
        for tool_def in TOOL_DISCOVERY.get("tools", []):
            if tool_def.get("name") not in existing_tool_names:
                tools.append({
                    "name": tool_def["name"],
                    "description": tool_def["description"],
                    "parameters": tool_def.get("parameters", {}),
                })

        return DiscoveryContext(
            system_prompt=system_prompt,
            tools=tools,
            always_on_slugs=always_on_slugs,
        )


tool_discovery_service = ToolDiscoveryService()
