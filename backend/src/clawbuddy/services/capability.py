"""Capability service — manages builtin and custom capabilities per workspace.

Replaces: apps/api/src/services/capability.service.ts
"""

from __future__ import annotations

from typing import Any

from loguru import logger
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from clawbuddy.constants import ALWAYS_ON_CAPABILITY_SLUGS
from clawbuddy.db.models import Capability, Workspace, WorkspaceCapability
from clawbuddy.services.config_validation import (
    decrypt_config_fields,
    encrypt_config_fields,
    mask_config_fields,
    merge_with_existing_config,
    validate_capability_config,
)

# Capability slugs that are always enabled and hidden from the management UI
HIDDEN_CAPABILITY_SLUGS = ["sub-agent-delegation"]


class CapabilityService:
    """Manages capabilities — registration, enabling/disabling, config."""

    # Capabilities that require an external API key
    REQUIRES_API_KEY: dict[str, str] = {
        "web-search": "gemini",
    }

    async def sync_builtin_capabilities(self, db: AsyncSession) -> None:
        """Upsert all built-in capability definitions into the database."""
        from clawbuddy.capabilities.builtin import BUILTIN_CAPABILITIES

        # Clean up removed builtin capabilities
        removed_slugs = ["file-ops"]
        for slug in removed_slugs:
            result = await db.execute(
                select(Capability).where(Capability.slug == slug)
            )
            existing = result.scalar_one_or_none()
            if existing and existing.builtin:
                await db.execute(
                    select(WorkspaceCapability)
                    .where(WorkspaceCapability.capability_id == existing.id)
                )
                from sqlalchemy import delete

                await db.execute(
                    delete(WorkspaceCapability).where(
                        WorkspaceCapability.capability_id == existing.id
                    )
                )
                await db.delete(existing)

        for cap in BUILTIN_CAPABILITIES:
            result = await db.execute(
                select(Capability).where(Capability.slug == cap["slug"])
            )
            existing = result.scalar_one_or_none()

            if existing:
                existing.name = cap["name"]
                existing.description = cap["description"]
                existing.icon = cap.get("icon")
                existing.category = cap["category"]
                existing.version = cap.get("version", "1.0.0")
                existing.tool_definitions = cap["tools"]
                existing.system_prompt = cap.get("systemPrompt")
                existing.docker_image = cap.get("sandbox", {}).get("dockerImage")
                existing.packages = cap.get("sandbox", {}).get("packages", [])
                existing.network_access = cap.get("sandbox", {}).get("networkAccess", False)
                existing.config_schema = cap.get("configSchema")
                existing.installation_script = cap.get("installationScript")
                existing.auth_type = cap.get("authType")
                existing.skill_type = cap.get("skillType")
            else:
                new_cap = Capability(
                    slug=cap["slug"],
                    name=cap["name"],
                    description=cap["description"],
                    icon=cap.get("icon"),
                    category=cap["category"],
                    version=cap.get("version", "1.0.0"),
                    tool_definitions=cap["tools"],
                    system_prompt=cap.get("systemPrompt"),
                    docker_image=cap.get("sandbox", {}).get("dockerImage"),
                    packages=cap.get("sandbox", {}).get("packages", []),
                    network_access=cap.get("sandbox", {}).get("networkAccess", False),
                    config_schema=cap.get("configSchema"),
                    installation_script=cap.get("installationScript"),
                    auth_type=cap.get("authType"),
                    skill_type=cap.get("skillType"),
                    builtin=True,
                )
                db.add(new_cap)

        await db.commit()
        await self.ensure_always_on_capabilities(db)

    async def ensure_always_on_capabilities(self, db: AsyncSession) -> None:
        """Ensure all always-on capabilities are enabled for every workspace."""
        ws_result = await db.execute(select(Workspace.id))
        workspace_ids = [row[0] for row in ws_result.all()]
        if not workspace_ids:
            return

        cap_result = await db.execute(
            select(Capability.id).where(Capability.slug.in_(ALWAYS_ON_CAPABILITY_SLUGS))
        )
        cap_ids = [row[0] for row in cap_result.all()]
        if not cap_ids:
            return

        for ws_id in workspace_ids:
            for cap_id in cap_ids:
                existing = await db.execute(
                    select(WorkspaceCapability).where(
                        WorkspaceCapability.workspace_id == ws_id,
                        WorkspaceCapability.capability_id == cap_id,
                    )
                )
                if not existing.scalar_one_or_none():
                    db.add(
                        WorkspaceCapability(
                            workspace_id=ws_id,
                            capability_id=cap_id,
                            enabled=True,
                        )
                    )
        await db.commit()

    async def list_all(self, db: AsyncSession) -> list[Capability]:
        result = await db.execute(
            select(Capability).order_by(Capability.category.asc())
        )
        return list(result.scalars().all())

    async def get_enabled_capabilities_for_workspace(
        self, db: AsyncSession, workspace_id: str
    ) -> list[dict[str, Any]]:
        """Get capabilities enabled for a workspace with their config."""
        from sqlalchemy.orm import selectinload

        result = await db.execute(
            select(WorkspaceCapability)
            .options(selectinload(WorkspaceCapability.capability))
            .where(
                WorkspaceCapability.workspace_id == workspace_id,
                WorkspaceCapability.enabled == True,
            )
        )
        wcs = result.scalars().all()

        out: list[dict[str, Any]] = []
        for wc in wcs:
            cap = wc.capability
            cap_dict: dict[str, Any] = {
                "id": cap.id,
                "slug": cap.slug,
                "name": cap.name,
                "description": cap.description,
                "icon": cap.icon,
                "category": cap.category,
                "version": cap.version,
                "toolDefinitions": cap.tool_definitions,
                "systemPrompt": cap.system_prompt,
                "dockerImage": cap.docker_image,
                "packages": cap.packages,
                "networkAccess": cap.network_access,
                "configSchema": cap.config_schema,
                "config": wc.config,
            }
            out.append(cap_dict)
        return out

    async def get_decrypted_capability_configs_for_workspace(
        self, db: AsyncSession, workspace_id: str
    ) -> dict[str, dict[str, str]]:
        """Get decrypted env vars for workspace-scoped capabilities."""
        capabilities = await self.get_enabled_capabilities_for_workspace(db, workspace_id)
        result: dict[str, dict[str, str]] = {}

        for cap in capabilities:
            schema = cap.get("configSchema") or []
            config = cap.get("config")
            if not schema or not config:
                continue

            decrypted = decrypt_config_fields(schema, config)
            env_vars: dict[str, str] = {}

            for field in schema:
                value = decrypted.get(field["key"])
                if value is not None and value != "":
                    env_vars[field["envVar"]] = str(value)

            if env_vars:
                result[cap["slug"]] = env_vars

        return result

    async def get_workspace_capability_settings(
        self, db: AsyncSession, workspace_id: str
    ) -> list[dict[str, Any]]:
        """Get all workspace capabilities (enabled and disabled) for management."""
        all_caps_result = await db.execute(
            select(Capability).order_by(Capability.category.asc())
        )
        all_caps = all_caps_result.scalars().all()

        wc_result = await db.execute(
            select(WorkspaceCapability).where(
                WorkspaceCapability.workspace_id == workspace_id
            )
        )
        wcs = wc_result.scalars().all()
        wc_map = {wc.capability_id: wc for wc in wcs}

        out: list[dict[str, Any]] = []
        for cap in all_caps:
            if cap.slug in HIDDEN_CAPABILITY_SLUGS:
                continue
            wc = wc_map.get(cap.id)
            schema = cap.config_schema or []
            raw_config = (wc.config if wc else None)
            masked_config = (
                mask_config_fields(schema, raw_config)
                if schema and raw_config
                else raw_config
            )
            out.append(
                {
                    "id": cap.id,
                    "slug": cap.slug,
                    "name": cap.name,
                    "description": cap.description,
                    "icon": cap.icon,
                    "category": cap.category,
                    "configSchema": cap.config_schema,
                    "enabled": wc.enabled if wc else False,
                    "alwaysOn": cap.slug in ALWAYS_ON_CAPABILITY_SLUGS,
                    "config": masked_config,
                    "workspaceCapabilityId": wc.id if wc else None,
                }
            )
        return out

    async def enable_capability(
        self,
        db: AsyncSession,
        workspace_id: str,
        slug: str,
        config: dict[str, Any] | None = None,
    ) -> WorkspaceCapability:
        """Enable a capability for a workspace."""
        result = await db.execute(
            select(Capability).where(Capability.slug == slug)
        )
        capability = result.scalar_one()
        schema = capability.config_schema or []

        processed_config = config

        if schema and config:
            validation = validate_capability_config(schema, config)
            if not validation.valid:
                raise ValueError(f"Config validation failed: {', '.join(validation.errors)}")

            # Preserve existing encrypted values when masked
            existing_result = await db.execute(
                select(WorkspaceCapability).where(
                    WorkspaceCapability.workspace_id == workspace_id,
                    WorkspaceCapability.capability_id == capability.id,
                )
            )
            existing = existing_result.scalar_one_or_none()
            if existing and existing.config:
                processed_config = merge_with_existing_config(
                    schema, config, existing.config
                )

            processed_config = encrypt_config_fields(schema, processed_config)
        elif any(f.get("required") for f in schema) and not config:
            raise ValueError("Configuration is required for this capability")

        # Upsert
        existing_result = await db.execute(
            select(WorkspaceCapability).where(
                WorkspaceCapability.workspace_id == workspace_id,
                WorkspaceCapability.capability_id == capability.id,
            )
        )
        existing = existing_result.scalar_one_or_none()

        if existing:
            existing.enabled = True
            if processed_config is not None:
                existing.config = processed_config
            await db.commit()
            await db.refresh(existing)
            return existing
        else:
            wc = WorkspaceCapability(
                workspace_id=workspace_id,
                capability_id=capability.id,
                enabled=True,
                config=processed_config,
            )
            db.add(wc)
            await db.commit()
            await db.refresh(wc)
            return wc

    async def disable_capability(
        self, db: AsyncSession, workspace_id: str, capability_id: str
    ) -> None:
        result = await db.execute(
            select(WorkspaceCapability).where(
                WorkspaceCapability.workspace_id == workspace_id,
                WorkspaceCapability.capability_id == capability_id,
            )
        )
        wc = result.scalar_one()
        wc.enabled = False
        await db.commit()

    async def disable_capability_by_slug(
        self, db: AsyncSession, workspace_id: str, slug: str
    ) -> None:
        cap_result = await db.execute(
            select(Capability).where(Capability.slug == slug)
        )
        cap = cap_result.scalar_one_or_none()
        if not cap:
            return
        await self.disable_capability(db, workspace_id, cap.id)

    async def remove_capability_override(
        self, db: AsyncSession, workspace_id: str, capability_id: str
    ) -> None:
        result = await db.execute(
            select(WorkspaceCapability).where(
                WorkspaceCapability.workspace_id == workspace_id,
                WorkspaceCapability.capability_id == capability_id,
            )
        )
        wc = result.scalar_one()
        await db.delete(wc)
        await db.commit()

    async def update_capability_config(
        self,
        db: AsyncSession,
        workspace_id: str,
        capability_id: str,
        config: dict[str, Any],
    ) -> WorkspaceCapability:
        """Update the config of an existing workspace capability."""
        result = await db.execute(
            select(WorkspaceCapability)
            .where(
                WorkspaceCapability.workspace_id == workspace_id,
                WorkspaceCapability.capability_id == capability_id,
            )
        )
        wc = result.scalar_one()

        # Load capability schema
        cap_result = await db.execute(
            select(Capability).where(Capability.id == capability_id)
        )
        capability = cap_result.scalar_one()
        schema = capability.config_schema or []

        if schema:
            validation = validate_capability_config(schema, config)
            if not validation.valid:
                raise ValueError(
                    f"Config validation failed: {', '.join(validation.errors)}"
                )

            # Preserve existing encrypted values when masked
            processed_config = merge_with_existing_config(
                schema, config, wc.config or {}
            )
            processed_config = encrypt_config_fields(schema, processed_config)
            wc.config = processed_config
        else:
            wc.config = config

        await db.commit()
        await db.refresh(wc)
        return wc

    def build_tool_definitions(
        self, capabilities: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """Build LLM tool definitions from enabled capabilities."""
        tools: list[dict[str, Any]] = []
        for cap in capabilities:
            defs = cap.get("toolDefinitions") or []
            for tool in defs:
                tools.append(
                    {
                        "name": tool["name"],
                        "description": tool["description"],
                        "parameters": tool["parameters"],
                    }
                )
        return tools

    def build_system_prompt(
        self,
        capabilities: list[dict[str, Any]],
        timezone: str | None = None,
    ) -> str:
        """Build a system prompt from capability blocks."""
        from clawbuddy.services.system_prompt_builder import (
            build_capability_blocks,
            build_system_prompt as _build_system_prompt,
        )

        cap_prompts = [
            {"name": c.get("name", ""), "systemPrompt": c.get("systemPrompt", "")}
            for c in capabilities
            if c.get("systemPrompt")
        ]
        return _build_system_prompt(cap_prompts, timezone)

    def resolve_tool_capability(
        self, tool_name: str, capabilities: list[dict[str, Any]]
    ) -> str | None:
        """Map a tool name back to its capability slug."""
        for cap in capabilities:
            defs = cap.get("toolDefinitions") or []
            if any(t["name"] == tool_name for t in defs):
                return cap["slug"]
        return None


capability_service = CapabilityService()
