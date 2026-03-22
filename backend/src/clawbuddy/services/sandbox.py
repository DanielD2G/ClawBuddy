"""Sandbox service — Docker container management for tool execution.

Replaces: apps/api/src/services/sandbox.service.ts

Manages persistent workspace containers via aiodocker:
- Container lifecycle (create, start, stop, destroy)
- Per-conversation Linux users with isolated home dirs
- Command execution with timeout and output limits
- File read/write via tar archives
- Credential file mounting (AWS, GWS)
- Idle container cleanup
"""

from __future__ import annotations

import asyncio
import io
import posixpath
import tarfile
import time
from dataclasses import dataclass
from typing import Any

import aiodocker
from loguru import logger
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from clawbuddy.constants import (
    EXEC_OUTPUT_MAX_BYTES,
    SANDBOX_BASE_IMAGE,
    SANDBOX_DEFAULT_EXEC_TIMEOUT_S,
    SANDBOX_FALLBACK_IMAGE,
    SANDBOX_IDLE_TIMEOUT_MS,
    SANDBOX_MAX_TIMEOUT_MS,
    SANDBOX_MEMORY_BYTES,
    SANDBOX_NANOCPUS,
    SANDBOX_PID_LIMIT,
    SANDBOX_STOP_TIMEOUT_S,
    SANDBOX_TIMEOUT_EXIT_CODE,
)
from clawbuddy.lib.sanitize import strip_null_bytes


@dataclass
class ExecResult:
    stdout: str
    stderr: str
    exit_code: int


async def _resolve_image(docker: aiodocker.Docker, workspace_id: str) -> str:
    """Resolve the Docker image to use for a workspace container.

    Tries: workspace skill image -> base image -> fallback (ubuntu:22.04).
    """
    from clawbuddy.services.image_builder import image_builder_service

    # Try workspace-specific skill image
    try:
        image = await image_builder_service.get_or_build_image(workspace_id)
    except Exception:
        image = SANDBOX_BASE_IMAGE

    # Check if resolved image actually exists locally
    try:
        await docker.images.inspect(image)
        return image
    except aiodocker.exceptions.DockerError:
        pass

    # Fallback to ubuntu:22.04
    image = SANDBOX_FALLBACK_IMAGE
    try:
        await docker.images.inspect(image)
    except aiodocker.exceptions.DockerError:
        # Pull the fallback image
        await docker.images.pull(image)

    return image


async def _exec_simple(
    container: aiodocker.docker.DockerContainer,
    cmd: str,
    user: str = "root",
) -> None:
    """Run a command in a container, ignoring output."""
    exec_obj = await container.exec(
        cmd=["bash", "-c", cmd],
        stdout=True,
        stderr=True,
        user=user,
    )
    # Drain output stream
    async with exec_obj.start() as stream:
        while await stream.read_out() is not None:
            pass


async def _exec_with_output(
    docker: aiodocker.Docker,
    container: aiodocker.docker.DockerContainer,
    command: str,
    timeout_s: int = SANDBOX_DEFAULT_EXEC_TIMEOUT_S,
    working_dir: str = "/workspace",
    user: str = "root",
) -> ExecResult:
    """Execute a command in a container and capture stdout/stderr with timeout."""
    timeout_ms = min(timeout_s * 1000, SANDBOX_MAX_TIMEOUT_MS)
    timeout_seconds = timeout_ms / 1000.0

    exec_obj = await container.exec(
        cmd=["bash", "-c", f"umask 000 && {command}"],
        stdout=True,
        stderr=True,
        workdir=working_dir,
        user=user,
    )

    stdout_chunks: list[bytes] = []
    stderr_chunks: list[bytes] = []

    try:
        async with asyncio.timeout(timeout_seconds):
            async with exec_obj.start(detach=False) as stream:
                # aiodocker multiplexes stdout/stderr via Message(stream, data).
                while True:
                    msg = await stream.read_out()
                    if msg is None:
                        break

                    chunk = msg.data if isinstance(msg.data, bytes) else str(msg.data).encode()
                    if msg.stream == 2:
                        stderr_chunks.append(chunk)
                    else:
                        stdout_chunks.append(chunk)

    except (asyncio.TimeoutError, TimeoutError):
        raw_stdout = b"".join(stdout_chunks).decode("utf-8", errors="replace")
        return ExecResult(
            stdout=raw_stdout[:EXEC_OUTPUT_MAX_BYTES],
            stderr="[TIMEOUT] Command exceeded time limit",
            exit_code=SANDBOX_TIMEOUT_EXIT_CODE,
        )

    # Get exit code
    exit_code = 0
    try:
        inspect_data = await exec_obj.inspect()
        exit_code = inspect_data.get("ExitCode", 0) or 0
    except Exception:
        pass

    raw_stdout = strip_null_bytes(
        b"".join(stdout_chunks).decode("utf-8", errors="replace")
    ).strip()[:EXEC_OUTPUT_MAX_BYTES]

    raw_stderr = strip_null_bytes(
        b"".join(stderr_chunks).decode("utf-8", errors="replace")
    ).strip()[:EXEC_OUTPUT_MAX_BYTES]

    # If there's an error exit code but no stderr, use stdout as stderr
    if not raw_stderr and exit_code != 0:
        raw_stderr = raw_stdout

    return ExecResult(
        stdout=raw_stdout,
        stderr=raw_stderr,
        exit_code=exit_code,
    )


class SandboxService:
    """Docker sandbox management for tool execution."""

    # ------------------------------------------------------------------
    # Container lifecycle
    # ------------------------------------------------------------------

    async def get_or_create_workspace_container(
        self,
        workspace_id: str,
        *,
        network_access: bool = True,
        docker_socket: bool = False,
        env_vars: dict[str, str] | None = None,
        db: AsyncSession | None = None,
    ) -> str:
        """Get or create the persistent workspace container.

        Stores containerId directly on the Workspace model.
        Returns the container ID.
        """
        from clawbuddy.db.models import Workspace

        if db is None:
            from clawbuddy.db.session import async_session_factory

            async with async_session_factory() as db:
                return await self._get_or_create_impl(
                    db, workspace_id, network_access, docker_socket, env_vars
                )

        return await self._get_or_create_impl(
            db, workspace_id, network_access, docker_socket, env_vars
        )

    async def _get_or_create_impl(
        self,
        db: AsyncSession,
        workspace_id: str,
        network_access: bool,
        docker_socket: bool,
        env_vars: dict[str, str] | None,
    ) -> str:
        from clawbuddy.db.models import Workspace

        stmt = select(Workspace).where(Workspace.id == workspace_id)
        result = await db.execute(stmt)
        workspace = result.scalar_one()

        docker = aiodocker.Docker()
        try:
            # If we have a running container, verify it's alive
            if workspace.container_id and workspace.container_status == "running":
                try:
                    container = docker.containers.container(workspace.container_id)
                    info = await container.show()
                    if info["State"]["Running"]:
                        return workspace.container_id
                except Exception:
                    pass  # Container is gone, will recreate below

            # Clean up old container if exists
            if workspace.container_id:
                try:
                    old = docker.containers.container(workspace.container_id)
                    await old.kill()
                    await old.delete(force=True)
                except Exception:
                    pass  # already gone

            # Resolve image
            image = await _resolve_image(docker, workspace_id)

            # Build env list (filter internal _-prefixed keys)
            env_list: list[str] | None = None
            if env_vars:
                env_list = [
                    f"{k}={v}"
                    for k, v in env_vars.items()
                    if not k.startswith("_")
                ]
                if not env_list:
                    env_list = None

            # Build binds
            binds = [f"clawbuddy-workspace-{workspace_id}:/workspace"]
            if docker_socket:
                binds.append("/var/run/docker.sock:/var/run/docker.sock")

            # Create container config
            config: dict[str, Any] = {
                "Image": image,
                "Cmd": ["sleep", "infinity"],
                "WorkingDir": "/workspace",
                "Labels": {
                    "clawbuddy.workspace": workspace_id,
                    "clawbuddy.type": "workspace",
                    "clawbuddy.managed": "true",
                },
                "HostConfig": {
                    "Memory": SANDBOX_MEMORY_BYTES,
                    "NanoCpus": SANDBOX_NANOCPUS,
                    "PidsLimit": SANDBOX_PID_LIMIT,
                    "NetworkMode": "bridge" if network_access else "none",
                    "Binds": binds,
                },
            }
            if env_list:
                config["Env"] = env_list

            container = await docker.containers.create_or_replace(
                name=f"clawbuddy-ws-{workspace_id[:12]}",
                config=config,
            )
            await container.start()

            container_id = container.id

            if docker_socket:
                await _exec_simple(
                    container,
                    "chmod 666 /var/run/docker.sock 2>/dev/null || true",
                )

            # Setup shared workspace structure
            await _exec_simple(
                container,
                "mkdir -p /workspace/__agent__ /workspace/.outputs && "
                "chmod 755 /workspace && chmod 777 /workspace/.outputs",
            )

            # Write credential files (AWS, GWS, etc.)
            if env_vars:
                await self._mount_credential_files(container, env_vars)

            # Update workspace in DB
            workspace.container_id = container_id
            workspace.container_status = "running"
            from datetime import datetime, timezone

            workspace.container_last_activity_at = datetime.now(timezone.utc)
            await db.commit()

            logger.info(
                f"[Sandbox] Created workspace container for {workspace_id}: "
                f"{container_id[:12]}"
            )
            return container_id
        finally:
            await docker.close()

    async def _mount_credential_files(
        self,
        container: aiodocker.docker.DockerContainer,
        env_vars: dict[str, str],
    ) -> None:
        """Write credential files (AWS, GWS) into the container."""
        files_to_mount: list[dict[str, str]] = []

        if env_vars.get("_AWS_CREDENTIALS_FILE"):
            files_to_mount.append({
                "path": "/root/.aws/credentials",
                "content": env_vars["_AWS_CREDENTIALS_FILE"],
                "heredoc_tag": "AWSEOF",
            })
        if env_vars.get("_AWS_CONFIG_FILE"):
            files_to_mount.append({
                "path": "/root/.aws/config",
                "content": env_vars["_AWS_CONFIG_FILE"],
                "heredoc_tag": "AWSCFGEOF",
            })
        if env_vars.get("_GWS_CREDENTIALS_FILE"):
            files_to_mount.append({
                "path": "/root/.config/gws/credentials.json",
                "content": env_vars["_GWS_CREDENTIALS_FILE"],
                "heredoc_tag": "GWSEOF",
            })

        if not files_to_mount:
            return

        # Create directories (root + skel)
        dirs: set[str] = set()
        for f in files_to_mount:
            parent = posixpath.dirname(f["path"])
            dirs.add(parent)
            dirs.add(parent.replace("/root/", "/etc/skel/"))

        mkdir_cmd = f"mkdir -p {' '.join(dirs)}"

        # Write each file and copy to skel
        write_parts: list[str] = []
        for f in files_to_mount:
            skel_path = f["path"].replace("/root/", "/etc/skel/")
            write_parts.append(
                f"cat > {f['path']} << '{f['heredoc_tag']}'\n"
                f"{f['content']}\n"
                f"{f['heredoc_tag']}\n"
                f"cp {f['path']} {skel_path}"
            )

        write_cmd = "\n".join(write_parts)
        await _exec_simple(container, f"{mkdir_cmd} && {write_cmd}")

        # Set GWS credentials env var
        if env_vars.get("_GWS_CREDENTIALS_FILE"):
            await _exec_simple(
                container,
                'echo "export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE='
                '/root/.config/gws/credentials.json" >> /etc/profile.d/gws.sh',
            )

    # ------------------------------------------------------------------
    # User management
    # ------------------------------------------------------------------

    async def ensure_conversation_user(
        self,
        workspace_id: str,
        chat_session_id: str,
        db: AsyncSession | None = None,
    ) -> str:
        """Create a Linux user inside the workspace container for a conversation.

        Returns the username. Idempotent — if user already exists, returns existing.
        """
        from clawbuddy.db.models import ChatSession, Workspace

        if db is None:
            from clawbuddy.db.session import async_session_factory

            async with async_session_factory() as db:
                return await self._ensure_user_impl(
                    db, workspace_id, chat_session_id
                )

        return await self._ensure_user_impl(db, workspace_id, chat_session_id)

    async def _ensure_user_impl(
        self,
        db: AsyncSession,
        workspace_id: str,
        chat_session_id: str,
    ) -> str:
        from clawbuddy.db.models import ChatSession, Workspace

        # Check if session already has a user
        session_stmt = select(ChatSession).where(ChatSession.id == chat_session_id)
        session_result = await db.execute(session_stmt)
        session = session_result.scalar_one()

        if session.linux_user:
            return session.linux_user

        # Get workspace container
        ws_stmt = select(Workspace).where(Workspace.id == workspace_id)
        ws_result = await db.execute(ws_stmt)
        workspace = ws_result.scalar_one()

        if not workspace.container_id or workspace.container_status != "running":
            raise RuntimeError("Workspace container is not running")

        docker = aiodocker.Docker()
        try:
            container = docker.containers.container(workspace.container_id)
            username = f"conv-{chat_session_id[:8]}"
            home_dir = f"/workspace/users/{username}"

            # Create user with home dir, bash shell (idempotent)
            await _exec_simple(
                container,
                f"id {username} 2>/dev/null || "
                f"(useradd -m -d {home_dir} -s /bin/bash {username} && "
                f"mkdir -p {home_dir} && chown {username}:{username} {home_dir}); "
                f"chmod 777 {home_dir} 2>/dev/null || true; "
                f"find {home_dir} -mindepth 1 -exec chmod a+rwX {{}} + 2>/dev/null || true",
            )

            # Grant passwordless sudo
            await _exec_simple(
                container,
                f"echo '{username} ALL=(ALL) NOPASSWD:ALL' > "
                f"/etc/sudoers.d/{username} 2>/dev/null || true",
            )

            # Copy credentials from skel if available (AWS, GWS)
            await _exec_simple(
                container,
                f"if [ -d /etc/skel/.aws ]; then "
                f"cp -r /etc/skel/.aws {home_dir}/.aws 2>/dev/null; "
                f"chown -R {username}:{username} {home_dir}/.aws 2>/dev/null; "
                f"fi || true\n"
                f"if [ -d /etc/skel/.config/gws ]; then "
                f"mkdir -p {home_dir}/.config/gws; "
                f"cp -r /etc/skel/.config/gws/* {home_dir}/.config/gws/ 2>/dev/null; "
                f"chown -R {username}:{username} {home_dir}/.config 2>/dev/null; "
                f"fi || true",
            )

            # Save linux user to session
            session.linux_user = username
            await db.commit()

            logger.info(
                f"[Sandbox] Created user {username} for session "
                f"{chat_session_id} in workspace {workspace_id}"
            )
            return username
        finally:
            await docker.close()

    # ------------------------------------------------------------------
    # Command execution
    # ------------------------------------------------------------------

    async def exec_in_workspace(
        self,
        workspace_id: str,
        command: str,
        *,
        timeout: int | None = None,
        working_dir: str | None = None,
        db: AsyncSession | None = None,
    ) -> ExecResult:
        """Execute a command in the workspace container as root."""
        from clawbuddy.db.models import Workspace

        if db is None:
            from clawbuddy.db.session import async_session_factory

            async with async_session_factory() as db:
                return await self._exec_in_workspace_impl(
                    db, workspace_id, command, timeout, working_dir
                )

        return await self._exec_in_workspace_impl(
            db, workspace_id, command, timeout, working_dir
        )

    async def _exec_in_workspace_impl(
        self,
        db: AsyncSession,
        workspace_id: str,
        command: str,
        timeout: int | None,
        working_dir: str | None,
    ) -> ExecResult:
        from clawbuddy.db.models import Workspace

        stmt = select(Workspace).where(Workspace.id == workspace_id)
        result = await db.execute(stmt)
        workspace = result.scalar_one()

        if not workspace.container_id or workspace.container_status != "running":
            raise RuntimeError("Workspace container is not running")

        docker = aiodocker.Docker()
        try:
            container = docker.containers.container(workspace.container_id)

            try:
                exec_result = await _exec_with_output(
                    docker,
                    container,
                    command,
                    timeout_s=timeout or SANDBOX_DEFAULT_EXEC_TIMEOUT_S,
                    working_dir=working_dir or "/workspace",
                )

                # Update last activity
                from datetime import datetime, timezone

                workspace.container_last_activity_at = datetime.now(timezone.utc)
                await db.commit()

                return exec_result
            except Exception as exc:
                msg = str(exc)
                if "no such container" in msg.lower() or "is not running" in msg.lower():
                    logger.warning(
                        f"[Sandbox] Workspace container gone for {workspace_id}, recreating..."
                    )
                    await self.get_or_create_workspace_container(
                        workspace_id, network_access=True, db=db
                    )
                    # Re-fetch workspace
                    await db.refresh(workspace)
                    if not workspace.container_id:
                        raise RuntimeError("Failed to recreate container") from exc
                    container = docker.containers.container(workspace.container_id)
                    return await _exec_with_output(
                        docker,
                        container,
                        command,
                        timeout_s=timeout or SANDBOX_DEFAULT_EXEC_TIMEOUT_S,
                        working_dir=working_dir or "/workspace",
                    )
                raise
        finally:
            await docker.close()

    # ------------------------------------------------------------------
    # File I/O via tar archives
    # ------------------------------------------------------------------

    async def write_file_to_container(
        self,
        workspace_id: str,
        file_path: str,
        data: bytes,
        db: AsyncSession | None = None,
    ) -> None:
        """Write a file directly into the workspace container using Docker putArchive.

        Bypasses shell argument limits — safe for large binary files (screenshots, etc.).
        """
        from clawbuddy.db.models import Workspace

        if db is None:
            from clawbuddy.db.session import async_session_factory

            async with async_session_factory() as db:
                await self._write_file_impl(db, workspace_id, file_path, data)
                return

        await self._write_file_impl(db, workspace_id, file_path, data)

    async def _write_file_impl(
        self,
        db: AsyncSession,
        workspace_id: str,
        file_path: str,
        data: bytes,
    ) -> None:
        from clawbuddy.db.models import Workspace

        stmt = select(Workspace).where(Workspace.id == workspace_id)
        result = await db.execute(stmt)
        workspace = result.scalar_one()

        if not workspace.container_id or workspace.container_status != "running":
            raise RuntimeError("Workspace container is not running")

        docker = aiodocker.Docker()
        try:
            container = docker.containers.container(workspace.container_id)
            dir_path = posixpath.dirname(file_path)
            filename = posixpath.basename(file_path)

            # Ensure the target directory exists
            await _exec_with_output(
                docker,
                container,
                f"mkdir -p {dir_path!r} && chmod 777 {dir_path!r}",
                timeout_s=5,
            )

            # Create tar archive with the file
            tar_buf = io.BytesIO()
            with tarfile.open(fileobj=tar_buf, mode="w") as tar:
                info = tarfile.TarInfo(name=filename)
                info.size = len(data)
                info.mode = 0o666
                tar.addfile(info, io.BytesIO(data))
            tar_buf.seek(0)

            # Put archive into the container
            await container.put_archive(dir_path, tar_buf.read())

            # Update last activity
            from datetime import datetime, timezone

            workspace.container_last_activity_at = datetime.now(timezone.utc)
            await db.commit()
        finally:
            await docker.close()

    async def read_file_from_container(
        self,
        workspace_id: str,
        file_path: str,
        db: AsyncSession | None = None,
    ) -> bytes:
        """Read a file directly from the workspace container using Docker getArchive.

        Bypasses stdout size limits — safe for large binary files (screenshots, etc.).
        """
        from clawbuddy.db.models import Workspace

        if db is None:
            from clawbuddy.db.session import async_session_factory

            async with async_session_factory() as db:
                return await self._read_file_impl(db, workspace_id, file_path)

        return await self._read_file_impl(db, workspace_id, file_path)

    async def _read_file_impl(
        self,
        db: AsyncSession,
        workspace_id: str,
        file_path: str,
    ) -> bytes:
        from clawbuddy.db.models import Workspace

        stmt = select(Workspace).where(Workspace.id == workspace_id)
        result = await db.execute(stmt)
        workspace = result.scalar_one()

        if not workspace.container_id or workspace.container_status != "running":
            raise RuntimeError("Workspace container is not running")

        docker = aiodocker.Docker()
        try:
            container = docker.containers.container(workspace.container_id)

            # getArchive returns tar data
            tar_data = await container.get_archive(file_path)

            # Extract the file from the tar stream
            # tar_data is a dict with 'data' key containing the tar bytes
            if isinstance(tar_data, dict):
                archive_bytes = tar_data.get("data", b"")
            else:
                # aiodocker may return raw bytes or a chunked response
                chunks = []
                async for chunk in tar_data:
                    chunks.append(chunk)
                archive_bytes = b"".join(chunks)

            # Parse tar archive to extract file content
            tar_buf = io.BytesIO(archive_bytes)
            with tarfile.open(fileobj=tar_buf, mode="r") as tar:
                for member in tar:
                    if member.isfile():
                        extracted = tar.extractfile(member)
                        if extracted:
                            return extracted.read()

            raise RuntimeError(f"File not found in archive: {file_path}")
        finally:
            await docker.close()

    # ------------------------------------------------------------------
    # Container management
    # ------------------------------------------------------------------

    async def stop_workspace_container(
        self, workspace_id: str, db: AsyncSession | None = None
    ) -> None:
        """Stop a workspace's sandbox container."""
        from clawbuddy.db.models import Workspace

        if db is None:
            from clawbuddy.db.session import async_session_factory

            async with async_session_factory() as db:
                await self._stop_container_impl(db, workspace_id)
                return

        await self._stop_container_impl(db, workspace_id)

    async def _stop_container_impl(
        self, db: AsyncSession, workspace_id: str
    ) -> None:
        from clawbuddy.db.models import Workspace

        stmt = select(Workspace).where(Workspace.id == workspace_id)
        result = await db.execute(stmt)
        workspace = result.scalar_one()

        if workspace.container_id:
            docker = aiodocker.Docker()
            try:
                container = docker.containers.container(workspace.container_id)
                try:
                    await container.stop(t=SANDBOX_STOP_TIMEOUT_S)
                except Exception:
                    pass
                try:
                    await container.delete(force=True)
                except Exception:
                    pass
            finally:
                await docker.close()

        workspace.container_status = "stopped"
        workspace.container_id = None
        await db.commit()

    async def get_workspace_container_status(
        self, workspace_id: str, db: AsyncSession | None = None
    ) -> dict[str, Any]:
        """Get the status of a workspace's sandbox container."""
        from clawbuddy.db.models import Workspace

        if db is None:
            from clawbuddy.db.session import async_session_factory

            async with async_session_factory() as db:
                return await self._get_status_impl(db, workspace_id)

        return await self._get_status_impl(db, workspace_id)

    async def _get_status_impl(
        self, db: AsyncSession, workspace_id: str
    ) -> dict[str, Any]:
        from clawbuddy.db.models import Workspace

        stmt = select(Workspace).where(Workspace.id == workspace_id)
        result = await db.execute(stmt)
        workspace = result.scalar_one()

        if workspace.container_id and workspace.container_status == "running":
            docker = aiodocker.Docker()
            try:
                container = docker.containers.container(workspace.container_id)
                try:
                    info = await container.show()
                    if not info["State"]["Running"]:
                        workspace.container_status = "stopped"
                        workspace.container_id = None
                        await db.commit()
                        return {"status": "stopped", "containerId": None}
                except Exception:
                    workspace.container_status = "stopped"
                    workspace.container_id = None
                    await db.commit()
                    return {"status": "stopped", "containerId": None}
            finally:
                await docker.close()

        return {
            "status": workspace.container_status or "stopped",
            "containerId": workspace.container_id,
        }

    async def start_workspace_container_with_capabilities(
        self,
        workspace_id: str,
        db: AsyncSession | None = None,
    ) -> str:
        """Start a workspace container with capability env vars already merged."""
        from clawbuddy.services.capability import capability_service

        config_env_vars = (
            await capability_service.get_decrypted_capability_configs_for_workspace(
                db, workspace_id
            )
        )

        if not config_env_vars:
            return await self.get_or_create_workspace_container(
                workspace_id, network_access=True, db=db
            )

        merged_env_vars: dict[str, str] = {}
        for env_map in config_env_vars.values():
            merged_env_vars.update(env_map)

        return await self.get_or_create_workspace_container(
            workspace_id,
            network_access=True,
            env_vars=merged_env_vars,
            db=db,
        )

    async def destroy_sandbox(
        self, sandbox_session_id: str, db: AsyncSession | None = None
    ) -> None:
        """Destroy a legacy per-session sandbox."""
        from clawbuddy.db.models import SandboxSession

        if db is None:
            from clawbuddy.db.session import async_session_factory

            async with async_session_factory() as db:
                await self._destroy_sandbox_impl(db, sandbox_session_id)
                return

        await self._destroy_sandbox_impl(db, sandbox_session_id)

    async def _destroy_sandbox_impl(
        self, db: AsyncSession, sandbox_session_id: str
    ) -> None:
        from clawbuddy.db.models import SandboxSession

        stmt = select(SandboxSession).where(SandboxSession.id == sandbox_session_id)
        result = await db.execute(stmt)
        session = result.scalar_one()

        if session.container_id:
            docker = aiodocker.Docker()
            try:
                container = docker.containers.container(session.container_id)
                try:
                    await container.stop(t=SANDBOX_STOP_TIMEOUT_S)
                except Exception:
                    pass
                try:
                    await container.delete(force=True)
                except Exception:
                    pass
            finally:
                await docker.close()

        from datetime import datetime, timezone

        session.status = "stopped"
        session.stopped_at = datetime.now(timezone.utc)
        await db.commit()

    # ------------------------------------------------------------------
    # Cleanup
    # ------------------------------------------------------------------

    async def cleanup_idle_containers(
        self, db: AsyncSession | None = None
    ) -> None:
        """Stop workspace containers idle for more than 10 minutes
        and clean up orphaned Docker containers.
        """
        if db is None:
            from clawbuddy.db.session import async_session_factory

            async with async_session_factory() as db:
                await self._cleanup_impl(db)
                return

        await self._cleanup_impl(db)

    async def _cleanup_impl(self, db: AsyncSession) -> None:
        from datetime import datetime, timezone

        from clawbuddy.db.models import SandboxSession, Workspace

        idle_threshold = datetime.fromtimestamp(
            (time.time() * 1000 - SANDBOX_IDLE_TIMEOUT_MS) / 1000,
            tz=timezone.utc,
        )

        # 1. Stop idle workspace containers
        from sqlalchemy import or_

        idle_stmt = select(Workspace).where(
            Workspace.container_status == "running",
            or_(
                Workspace.container_last_activity_at.is_(None),
                Workspace.container_last_activity_at < idle_threshold,
            ),
        )
        idle_result = await db.execute(idle_stmt)
        idle_workspaces = idle_result.scalars().all()

        for workspace in idle_workspaces:
            logger.info(
                f"[Sandbox] Stopping idle workspace container for {workspace.id}"
            )
            try:
                await self._stop_container_impl(db, workspace.id)
            except Exception as exc:
                logger.error(
                    f"[Sandbox] Failed to stop idle container for {workspace.id}: {exc}"
                )

        # 2. Clean orphaned Docker containers
        docker = aiodocker.Docker()
        try:
            containers = await docker.containers.list(
                all=True,
                filters={"label": ["clawbuddy.managed=true"]},
            )

            # Get active container IDs from DB
            sandbox_stmt = select(SandboxSession.container_id).where(
                SandboxSession.status == "running"
            )
            sandbox_result = await db.execute(sandbox_stmt)
            active_sandbox_ids = {
                row[0] for row in sandbox_result.all() if row[0]
            }

            ws_stmt = select(Workspace.container_id).where(
                Workspace.container_status == "running"
            )
            ws_result = await db.execute(ws_stmt)
            active_ws_ids = {row[0] for row in ws_result.all() if row[0]}

            all_active_ids = active_sandbox_ids | active_ws_ids

            for container_info in containers:
                container_id = container_info["Id"]
                if container_id not in all_active_ids:
                    created_ts = container_info.get("Created", 0)
                    # Created can be Unix timestamp
                    if isinstance(created_ts, (int, float)):
                        started_at_ms = created_ts * 1000
                    else:
                        started_at_ms = 0

                    if time.time() * 1000 - started_at_ms > SANDBOX_IDLE_TIMEOUT_MS:
                        logger.info(
                            f"[Sandbox] Removing orphaned container "
                            f"{container_id[:12]}"
                        )
                        container = docker.containers.container(container_id)
                        try:
                            await container.stop(t=5)
                        except Exception:
                            pass
                        try:
                            await container.delete(force=True)
                        except Exception:
                            pass
        except Exception as exc:
            logger.error(f"[Sandbox] Failed to clean orphaned containers: {exc}")
        finally:
            await docker.close()


sandbox_service = SandboxService()
