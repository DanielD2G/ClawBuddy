"""Skill service — manages .skill file upload, sync, and deletion.

Replaces: apps/api/src/services/skill.service.ts
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from loguru import logger
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from clawbuddy.capabilities.skill_parser import parse_skill_file
from clawbuddy.db.models import Capability
from clawbuddy.services.storage import storage_service

SKILLS_PREFIX = "skills/"


@dataclass
class SkillUploadResult:
    success: bool
    error: str | None = None
    logs: str | None = None
    slug: str | None = None


class SkillService:
    """Manages custom skill capabilities (.skill files)."""

    def _get_bundled_skills_dir(self) -> Path | None:
        """Return the bundled skills directory if present."""
        base_dir = Path(__file__).resolve().parent.parent.parent.parent
        for candidate in (base_dir / "skills", Path.cwd() / "skills"):
            if candidate.is_dir():
                return candidate
        return None

    def _get_bundled_skill_path(self, filename: str) -> Path | None:
        """Return the path for a bundled skill file by filename."""
        skills_dir = self._get_bundled_skills_dir()
        if not skills_dir:
            return None
        path = skills_dir / filename
        return path if path.is_file() else None

    async def upload_skill(
        self,
        file_content: str | bytes,
        db: AsyncSession,
        on_build_log: Any | None = None,
    ) -> SkillUploadResult:
        """Upload and install a skill from a .skill file.

        If the skill has an installation script, it will be validated
        by attempting a Docker build first.
        """
        # Parse the JSON
        content_str = (
            file_content
            if isinstance(file_content, str)
            else file_content.decode("utf-8")
        )
        try:
            raw = json.loads(content_str)
        except json.JSONDecodeError:
            return SkillUploadResult(
                success=False, error="Invalid JSON in .skill file"
            )

        # Validate and parse
        try:
            parsed = parse_skill_file(raw)
        except Exception as exc:
            return SkillUploadResult(
                success=False, error=f"Skill validation failed: {exc}"
            )

        skill = parsed.skill
        db_data = parsed.db_data

        # If skill has installation script, test the Docker build
        if skill.get("installation"):
            from clawbuddy.services.image_builder import image_builder_service

            if on_build_log:
                on_build_log("Testing installation script...")
            build_result = await image_builder_service.test_skill_installation(
                skill["installation"], on_build_log
            )
            if not build_result.success:
                return SkillUploadResult(
                    success=False,
                    error="Installation script failed to build",
                    logs=build_result.logs,
                )
            if on_build_log:
                on_build_log("Installation script validated successfully.")

        # Upload .skill file to MinIO
        skill_key = f"{SKILLS_PREFIX}{skill['slug']}.skill"
        await storage_service.upload(
            skill_key, content_str.encode("utf-8"), "application/json"
        )

        # Upsert capability in DB
        result = await db.execute(
            select(Capability).where(Capability.slug == db_data["slug"])
        )
        existing = result.scalar_one_or_none()

        if existing:
            for key, value in db_data.items():
                if hasattr(existing, key):
                    setattr(existing, key, value)
            existing.skill_file_key = skill_key
        else:
            cap = Capability(
                **db_data,
                skill_file_key=skill_key,
            )
            db.add(cap)

        await db.commit()

        # Re-index tool discovery after skill changes (fire-and-forget)
        try:
            from clawbuddy.services.tool_discovery import tool_discovery_service

            await tool_discovery_service.index_capabilities(db)
        except Exception as exc:
            logger.error(
                f"[SkillService] Failed to re-index tool discovery: {exc}"
            )

        return SkillUploadResult(success=True, slug=skill["slug"])

    async def sync_skills_from_storage(
        self,
        db: AsyncSession,
        *,
        throw_on_error: bool = False,
    ) -> None:
        """Sync skills from MinIO storage into the database.

        Called on server startup.
        """
        try:
            # First, seed bundled skills from filesystem to MinIO if they don't exist
            await self._seed_bundled_skills(db)

            # List all .skill files in MinIO
            objects = await storage_service.list_objects(SKILLS_PREFIX)

            for obj in objects:
                key = obj.get("Key", "")
                if not key.endswith(".skill"):
                    continue

                try:
                    body = await storage_service.download(key)
                    if not body:
                        continue

                    # Read the file content
                    if hasattr(body, "read"):
                        content = await body.read()
                        if isinstance(content, bytes):
                            content = content.decode("utf-8")
                    elif hasattr(body, "__aiter__"):
                        chunks: list[bytes] = []
                        async for chunk in body:
                            if isinstance(chunk, bytes):
                                chunks.append(chunk)
                            else:
                                chunks.append(chunk.encode("utf-8"))
                        content = b"".join(chunks).decode("utf-8")
                    else:
                        content = str(body)

                    try:
                        raw = json.loads(content)
                    except json.JSONDecodeError:
                        bundled_path = self._get_bundled_skill_path(
                            Path(key).name
                        )
                        if bundled_path is None:
                            raise

                        content = bundled_path.read_text("utf-8")
                        raw = json.loads(content)
                        await storage_service.upload(
                            key,
                            content.encode("utf-8"),
                            "application/json",
                        )

                    parsed = parse_skill_file(raw)
                    db_data = parsed.db_data

                    # Upsert capability in DB
                    result = await db.execute(
                        select(Capability).where(
                            Capability.slug == db_data["slug"]
                        )
                    )
                    existing = result.scalar_one_or_none()

                    if existing:
                        existing.name = db_data["name"]
                        existing.description = db_data["description"]
                        existing.icon = db_data.get("icon")
                        existing.category = db_data["category"]
                        existing.version = db_data.get("version", "1.0.0")
                        existing.tool_definitions = db_data["toolDefinitions"]
                        existing.system_prompt = db_data.get("systemPrompt")
                        existing.network_access = db_data.get(
                            "networkAccess", False
                        )
                        existing.config_schema = db_data.get("configSchema")
                        existing.skill_type = db_data.get("skillType")
                        existing.installation_script = db_data.get(
                            "installationScript"
                        )
                        existing.source = db_data.get("source", "skill")
                        existing.skill_file_key = key
                    else:
                        cap = Capability(
                            **db_data,
                            skill_file_key=key,
                        )
                        db.add(cap)

                except Exception as exc:
                    logger.error(
                        f"[SkillService] Failed to sync skill {key}: {exc}"
                    )

            await db.commit()
        except Exception as exc:
            logger.error(
                f"[SkillService] Failed to sync skills from storage: {exc}"
            )
            if throw_on_error:
                raise

    async def _seed_bundled_skills(self, db: AsyncSession) -> None:
        """Seed bundled .skill files from the filesystem to MinIO.

        Only uploads if the version doesn't match or doesn't exist in DB.
        """
        skills_dir = self._get_bundled_skills_dir()
        if skills_dir is None:
            return

        skill_files = [
            f for f in skills_dir.iterdir() if f.suffix == ".skill"
        ]

        for skill_file in skill_files:
            key = f"{SKILLS_PREFIX}{skill_file.name}"

            try:
                content = skill_file.read_text("utf-8")
                parsed = parse_skill_file(json.loads(content))
                skill = parsed.skill

                # Check if we need to update: compare version with DB
                result = await db.execute(
                    select(Capability.version).where(
                        Capability.slug == skill.slug
                    )
                )
                row = result.first()
                if row and row[0] == skill.version:
                    continue

                await storage_service.upload(
                    key, content.encode("utf-8"), "application/json"
                )
            except Exception as exc:
                logger.error(
                    f"[SkillService] Failed to seed bundled skill "
                    f"{skill_file.name}: {exc}"
                )

    async def delete_skill(
        self, slug: str, db: AsyncSession
    ) -> SkillUploadResult:
        """Delete a skill (only non-builtin skills)."""
        result = await db.execute(
            select(Capability).where(Capability.slug == slug)
        )
        capability = result.scalar_one_or_none()

        if not capability:
            return SkillUploadResult(success=False, error="Skill not found")

        if capability.source == "builtin":
            return SkillUploadResult(
                success=False, error="Cannot delete builtin capabilities"
            )

        # Remove from MinIO
        if capability.skill_file_key:
            try:
                await storage_service.delete_object(capability.skill_file_key)
            except Exception:
                pass  # Ignore deletion errors

        # Remove from DB
        await db.delete(capability)
        await db.commit()

        # Re-index tool discovery after skill deletion
        try:
            from clawbuddy.services.tool_discovery import tool_discovery_service

            await tool_discovery_service.index_capabilities(db)
        except Exception as exc:
            logger.error(
                f"[SkillService] Failed to re-index tool discovery after "
                f"delete: {exc}"
            )

        return SkillUploadResult(success=True)

    async def list_skills(self, db: AsyncSession) -> list[Capability]:
        """List all skills (non-builtin capabilities)."""
        result = await db.execute(
            select(Capability)
            .where(Capability.source != "builtin")
            .order_by(Capability.category.asc())
        )
        return list(result.scalars().all())


skill_service = SkillService()
