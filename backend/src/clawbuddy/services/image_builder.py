"""Docker image builder service.

Replaces: apps/api/src/services/image-builder.service.ts
Builds and manages Docker images for sandbox containers:
- Base sandbox image (from Dockerfile constant)
- Workspace-specific skill images with installation scripts
- Test builds for skill installation verification
"""

from __future__ import annotations

import hashlib
import io
import tarfile
from typing import Callable

import aiodocker
from loguru import logger
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload

from clawbuddy.constants import (
    IMAGE_TAG_HASH_LENGTH,
    SANDBOX_BASE_DOCKERFILE,
    SANDBOX_BASE_IMAGE,
)


class _BuildResult:
    __slots__ = ("success", "logs", "tag")

    def __init__(self, success: bool, logs: str, tag: str | None = None) -> None:
        self.success = success
        self.logs = logs
        self.tag = tag


def _dockerfile_to_tar(dockerfile: str) -> io.BytesIO:
    """Create an in-memory tar archive containing a single Dockerfile."""
    dockerfile_bytes = dockerfile.encode("utf-8")
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        info = tarfile.TarInfo(name="Dockerfile")
        info.size = len(dockerfile_bytes)
        tar.addfile(info, io.BytesIO(dockerfile_bytes))
    buf.seek(0)
    return buf


class ImageBuilderService:
    """Build and manage Docker images for sandboxes."""

    async def ensure_base_image(
        self, on_log: Callable[[str], None] | None = None
    ) -> None:
        """Ensure the base sandbox image exists, building it from the Dockerfile if missing."""
        docker = aiodocker.Docker()
        try:
            try:
                await docker.images.inspect(SANDBOX_BASE_IMAGE)
                return  # already exists
            except aiodocker.exceptions.DockerError:
                pass

            if on_log:
                on_log("Building base sandbox image...")

            result = await self._build_from_dockerfile(
                docker, SANDBOX_BASE_DOCKERFILE, SANDBOX_BASE_IMAGE, on_log
            )

            if not result.success:
                raise RuntimeError(
                    f"Failed to build base sandbox image: {result.logs}"
                )

            if on_log:
                on_log("Base sandbox image built successfully")
        finally:
            await docker.close()

    async def test_skill_installation(
        self,
        installation_script: str,
        on_log: Callable[[str], None] | None = None,
    ) -> _BuildResult:
        """Test a skill's installation script by attempting a Docker build.

        Returns success/failure with build logs.
        """
        await self.ensure_base_image(on_log)

        import time

        test_tag = f"clawbuddy-skill-test-{int(time.time() * 1000)}"
        dockerfile = "\n".join([
            f"FROM {SANDBOX_BASE_IMAGE}",
            "USER root",
            f"RUN {installation_script}",
            "USER sandbox",
        ])

        docker = aiodocker.Docker()
        try:
            result = await self._build_from_dockerfile(
                docker, dockerfile, test_tag, on_log
            )

            # Clean up test image on success
            if result.success:
                try:
                    await docker.images.delete(test_tag, force=True)
                except Exception:
                    pass

            return result
        except Exception as exc:
            return _BuildResult(success=False, logs=f"Build error: {exc}")
        finally:
            await docker.close()

    async def get_or_build_image(
        self,
        workspace_id: str,
        db: AsyncSession | None = None,
        on_log: Callable[[str], None] | None = None,
    ) -> str:
        """Build or retrieve the skill image for a workspace.

        Combines all workspace-enabled capabilities with installation scripts
        into a single Docker image. Uses a deterministic tag based on the
        hash of all installation scripts.
        """
        await self.ensure_base_image(on_log)

        # Get workspace capabilities with installation scripts
        from clawbuddy.db.models import Capability, WorkspaceCapability

        if db is None:
            from clawbuddy.db.session import async_session_factory

            async with async_session_factory() as db:
                return await self._build_workspace_image(
                    db, workspace_id, on_log
                )
        else:
            return await self._build_workspace_image(db, workspace_id, on_log)

    async def _build_workspace_image(
        self,
        db: AsyncSession,
        workspace_id: str,
        on_log: Callable[[str], None] | None,
    ) -> str:
        from clawbuddy.db.models import Capability, WorkspaceCapability

        stmt = (
            select(WorkspaceCapability)
            .options(joinedload(WorkspaceCapability.capability))
            .where(
                WorkspaceCapability.workspace_id == workspace_id,
                WorkspaceCapability.enabled.is_(True),
            )
        )
        result = await db.execute(stmt)
        wcs = result.unique().scalars().all()

        # Filter to those with installation scripts
        capabilities = [
            wc.capability
            for wc in wcs
            if wc.capability and wc.capability.installation_script
        ]
        # Sort by slug for deterministic hashing
        capabilities.sort(key=lambda c: c.slug)

        if not capabilities:
            return SANDBOX_BASE_IMAGE

        # Generate deterministic tag from installation scripts
        hash_input = "\n".join(
            f"{c.slug}:{c.installation_script}" for c in capabilities
        )
        tag_hash = hashlib.sha256(hash_input.encode()).hexdigest()[
            :IMAGE_TAG_HASH_LENGTH
        ]
        tag = f"clawbuddy-sandbox-skills-{tag_hash}"

        # Check if image already exists
        docker = aiodocker.Docker()
        try:
            try:
                await docker.images.inspect(tag)
                return tag
            except aiodocker.exceptions.DockerError:
                pass

            # Generate Dockerfile
            lines = [f"FROM {SANDBOX_BASE_IMAGE}", "USER root", ""]
            for cap in capabilities:
                if cap.installation_script:
                    lines.append(f"# Skill: {cap.slug}")
                    lines.append(f"RUN {cap.installation_script}")
                    lines.append("")
            lines.append("USER sandbox")
            lines.append('CMD ["sleep", "infinity"]')

            dockerfile = "\n".join(lines)
            build_result = await self._build_from_dockerfile(
                docker, dockerfile, tag, on_log
            )

            if not build_result.success:
                logger.error(
                    f"[ImageBuilder] Failed to build skill image: {build_result.logs}"
                )
                return SANDBOX_BASE_IMAGE

            return tag
        finally:
            await docker.close()

    async def _build_from_dockerfile(
        self,
        docker: aiodocker.Docker,
        dockerfile: str,
        tag: str,
        on_log: Callable[[str], None] | None = None,
    ) -> _BuildResult:
        """Build a Docker image from a Dockerfile string."""
        tar_buf = _dockerfile_to_tar(dockerfile)
        logs: list[str] = []

        try:
            # aiodocker.images.build returns an async generator of build log lines
            async for line_data in docker.images.build(
                fileobj=tar_buf, tag=tag, encoding="gzip"
            ):
                if isinstance(line_data, dict):
                    stream_text = line_data.get("stream", "")
                    if stream_text:
                        text = stream_text.rstrip("\n")
                        if text:
                            logs.append(text)
                            if on_log:
                                on_log(text)
                    error_text = line_data.get("error", "")
                    if error_text:
                        logs.append(f"ERROR: {error_text}")
                        if on_log:
                            on_log(f"ERROR: {error_text}")
        except Exception as exc:
            logs.append(f"Build exception: {exc}")
            return _BuildResult(
                success=False, logs="\n".join(logs)
            )

        has_error = any(line.startswith("ERROR:") for line in logs)
        return _BuildResult(
            success=not has_error,
            logs="\n".join(logs),
            tag=None if has_error else tag,
        )

    async def invalidate_images(self) -> None:
        """Remove old skill images to free disk space."""
        docker = aiodocker.Docker()
        try:
            images = await docker.images.list()
            for img in images:
                tags = img.get("RepoTags") or []
                for tag in tags:
                    if tag.startswith("clawbuddy-sandbox-skills-"):
                        try:
                            await docker.images.delete(tag, force=True)
                        except Exception:
                            pass
        except Exception as exc:
            logger.error(f"[ImageBuilder] Failed to invalidate images: {exc}")
        finally:
            await docker.close()


image_builder_service = ImageBuilderService()
