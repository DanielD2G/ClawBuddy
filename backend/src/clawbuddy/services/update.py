"""Update service — manages self-updating via Docker Swarm.

Replaces: apps/api/src/services/update.service.ts

Handles checking for GitHub releases, pulling Docker images,
and rolling out updates via Docker Swarm service updates.
Uses aiodocker for Docker API communication.
"""

from __future__ import annotations

import asyncio
import re
import time
from datetime import datetime, timezone
from typing import Any, Literal

import httpx
from loguru import logger
from sqlalchemy import select, update as sa_update
from sqlalchemy.ext.asyncio import AsyncSession

from clawbuddy.db.models import AppUpdateRun
from clawbuddy.db.session import async_session_factory
from clawbuddy.lib.build_info import get_build_info
from clawbuddy.settings import settings as env

UPDATE_FORCE = getattr(env, "UPDATE_FORCE", "").lower() in ("true", "1", "yes")


def _camel_to_snake(name: str) -> str:
    """Convert camelCase to snake_case."""
    return re.sub(r"(?<=[a-z0-9])([A-Z])", r"_\1", name).lower()
UPDATE_CACHE_TTL_S = 15 * 60
GITHUB_RELEASES_URL = (
    "https://api.github.com/repos/DanielD2G/ClawBuddy/releases/latest"
)
API_SERVICE_NAME = "clawbuddy-app_api"
WEB_SERVICE_NAME = "clawbuddy-app_web"
STEP_DELAY_NS = 10_000_000_000
STEP_MONITOR_NS = 30_000_000_000

StepStatus = Literal["pending", "running", "done", "error"]
RunStatus = Literal["pending", "running", "completed", "failed"]
UpdatePhase = Literal[
    "pending",
    "pulling-images",
    "waiting-for-api",
    "deploying-web",
    "waiting-for-web",
    "completed",
    "failed",
]


# ── Types ────────────────────────────────────────────────────


class LatestReleaseInfo:
    def __init__(
        self,
        version: str,
        name: str,
        body: str,
        url: str,
        published_at: str,
    ) -> None:
        self.version = version
        self.name = name
        self.body = body
        self.url = url
        self.published_at = published_at


class StepProgress:
    def __init__(
        self,
        status: StepStatus = "pending",
        progress: str = "",
        error: str | None = None,
    ) -> None:
        self.status = status
        self.progress = progress
        self.error = error

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {"status": self.status, "progress": self.progress}
        if self.error:
            d["error"] = self.error
        return d


def _create_step(progress: str) -> dict[str, Any]:
    return {"status": "pending", "progress": progress}


def _create_default_progress() -> dict[str, Any]:
    return {
        "pullApi": _create_step("Waiting to pull the API image"),
        "pullWeb": _create_step("Waiting to pull the web image"),
        "apiDeploy": _create_step("Waiting to deploy the API"),
        "webDeploy": _create_step("Waiting to deploy the web app"),
        "observed": {
            "apiVersion": None,
            "apiUpdateState": None,
            "apiUpdateMessage": None,
            "webVersion": None,
            "webUpdateState": None,
            "webUpdateMessage": None,
        },
    }


def _parse_progress(progress: Any) -> dict[str, Any]:
    if not isinstance(progress, dict):
        return _create_default_progress()
    default = _create_default_progress()
    return {
        "pullApi": {**default["pullApi"], **(progress.get("pullApi") or {})},
        "pullWeb": {**default["pullWeb"], **(progress.get("pullWeb") or {})},
        "apiDeploy": {**default["apiDeploy"], **(progress.get("apiDeploy") or {})},
        "webDeploy": {**default["webDeploy"], **(progress.get("webDeploy") or {})},
        "observed": {**default["observed"], **(progress.get("observed") or {})},
    }


# ── Version utilities ────────────────────────────────────────


def normalize_version(value: str | None) -> str | None:
    if not value:
        return None
    cleaned = value.strip().removeprefix("refs/tags/")
    return cleaned if cleaned.startswith("v") else f"v{cleaned}"


def _parse_semver(value: str | None) -> tuple[int, int, int] | None:
    normalized = normalize_version(value)
    if not normalized:
        return None
    m = re.match(r"^v(\d+)\.(\d+)\.(\d+)", normalized)
    return (int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else None


def is_release_newer(
    current_version: str | None, target_version: str
) -> bool:
    current = _parse_semver(current_version)
    target = _parse_semver(target_version)
    if not target:
        return False
    if not current:
        return True
    for c, t in zip(current, target):
        if t > c:
            return True
        if t < c:
            return False
    return False


def extract_version_from_image(image: str | None) -> str | None:
    if not image:
        return None
    without_digest = image.split("@")[0]
    last_slash = without_digest.rfind("/")
    last_colon = without_digest.rfind(":")
    if last_colon <= last_slash:
        return None
    return normalize_version(without_digest[last_colon + 1 :])


def _err_msg(error: object) -> str:
    return str(error) if isinstance(error, Exception) else str(error)


# ── Serialization ────────────────────────────────────────────


def _serialize_run(run: AppUpdateRun | None) -> dict[str, Any] | None:
    if not run:
        return None
    return {
        "id": run.id,
        "status": run.status,
        "phase": run.phase,
        "currentVersion": run.current_version,
        "targetVersion": run.target_version,
        "targetReleaseName": run.target_release_name,
        "targetReleaseUrl": run.target_release_url,
        "targetPublishedAt": (
            run.target_published_at.isoformat() if run.target_published_at else None
        ),
        "targetReleaseNotes": run.target_release_notes,
        "phaseMessage": run.phase_message,
        "progress": _parse_progress(run.progress),
        "error": run.error,
        "startedAt": run.started_at.isoformat() if run.started_at else None,
        "completedAt": (
            run.completed_at.isoformat() if run.completed_at else None
        ),
        "createdAt": run.created_at.isoformat() if run.created_at else None,
        "updatedAt": run.updated_at.isoformat() if run.updated_at else None,
    }


# ── Docker helpers ───────────────────────────────────────────


def _get_docker():  # type: ignore[no-untyped-def]
    """Lazy import of aiodocker."""
    import aiodocker

    return aiodocker.Docker()


async def _get_service_by_name(
    name: str,
) -> dict[str, Any] | None:
    docker = _get_docker()
    try:
        services = await docker.services.list(filters={"name": [name]})
        return services[0] if services else None
    finally:
        await docker.close()


async def _get_install_support() -> dict[str, Any]:
    docker = _get_docker()
    try:
        info = await docker.system.info()
        swarm = info.get("Swarm", {})
        if swarm.get("LocalNodeState") != "active":
            return {"supported": False, "reason": "Docker Swarm is not active"}

        api_service = await _get_service_by_name(API_SERVICE_NAME)
        web_service = await _get_service_by_name(WEB_SERVICE_NAME)

        if not api_service or not web_service:
            return {
                "supported": False,
                "reason": "Managed ClawBuddy Swarm services were not found on this host",
            }

        return {
            "supported": True,
            "reason": None,
            "apiService": api_service,
            "webService": web_service,
        }
    except Exception as exc:
        return {
            "supported": False,
            "reason": f"Docker is not reachable: {_err_msg(exc)}",
        }
    finally:
        await docker.close()


def _get_current_version_from_build() -> str | None:
    build = get_build_info()
    version = normalize_version(build.get("version"))
    return version if version and version != "vdev" else None


async def _get_current_installed_version() -> str:
    build_version = _get_current_version_from_build()
    if build_version:
        return build_version

    service = await _get_service_by_name(API_SERVICE_NAME)
    if service:
        image = (
            service.get("Spec", {})
            .get("TaskTemplate", {})
            .get("ContainerSpec", {})
            .get("Image")
        )
        img_version = extract_version_from_image(image)
        if img_version and img_version != "vlatest":
            return img_version

    return "legacy/latest"


def _build_target_image(
    service: dict[str, Any] | None,
    version: str,
    fallback_image: str,
) -> str:
    image_tag = version.lstrip("v")
    current_image = (
        (service or {})
        .get("Spec", {})
        .get("TaskTemplate", {})
        .get("ContainerSpec", {})
        .get("Image", "")
    )
    without_digest = current_image.split("@")[0]
    last_slash = without_digest.rfind("/")
    last_colon = without_digest.rfind(":")

    if last_colon > last_slash:
        return f"{without_digest[:last_colon]}:{image_tag}"
    if without_digest:
        return f"{without_digest}:{image_tag}"
    return f"{fallback_image}:{image_tag}"


async def _pull_image(
    image: str,
    on_progress: Any,  # Callable[[str], Awaitable[None]]
) -> None:
    docker = _get_docker()
    try:
        # Parse image into repository:tag
        if ":" in image.split("/")[-1]:
            repo, tag = image.rsplit(":", 1)
        else:
            repo, tag = image, "latest"

        async for chunk in docker.images.pull(repo, tag=tag, stream=True):
            status = chunk.get("status", "Pulling image")
            layer_id = chunk.get("id", "")
            detail = chunk.get("progressDetail", {})
            current = detail.get("current", 0)
            total = detail.get("total", 0)
            pct = f" {round(current / total * 100)}%" if current > 0 and total > 0 else ""
            message = f"{status} ({layer_id}){pct}" if layer_id else f"{status}{pct}"
            await on_progress(message)
    finally:
        await docker.close()


def _get_service_failure(service: dict[str, Any] | None) -> str | None:
    if not service:
        return None
    state = service.get("UpdateStatus", {}).get("State")
    if not state:
        return None
    if state.startswith("rollback"):
        return (
            service.get("UpdateStatus", {}).get("Message")
            or "Swarm rolled the service back"
        )
    if state == "paused":
        return (
            service.get("UpdateStatus", {}).get("Message")
            or "Swarm paused the service update"
        )
    return None


def _is_service_stable_at_target(
    service: dict[str, Any] | None, target_version: str
) -> bool:
    if not service:
        return False
    image = (
        service.get("Spec", {})
        .get("TaskTemplate", {})
        .get("ContainerSpec", {})
        .get("Image")
    )
    version = extract_version_from_image(image)
    if version != target_version:
        return False
    status = service.get("ServiceStatus", {})
    if not status:
        return True
    desired = status.get("DesiredTasks", 0)
    running = status.get("RunningTasks", 0)
    return desired == 0 or running >= desired


async def _update_service_image(
    service: dict[str, Any], image: str
) -> None:
    docker = _get_docker()
    try:
        version_index = service.get("Version", {}).get("Index")
        if version_index is None:
            raise RuntimeError("Swarm service version index is missing")

        spec = dict(service.get("Spec", {}))
        task_template = dict(spec.get("TaskTemplate", {}))
        container_spec = dict(task_template.get("ContainerSpec", {}))

        # Configure rollout
        spec["UpdateConfig"] = {
            "Parallelism": 1,
            "Delay": spec.get("UpdateConfig", {}).get("Delay", STEP_DELAY_NS),
            "FailureAction": "rollback",
            "Monitor": spec.get("UpdateConfig", {}).get("Monitor", STEP_MONITOR_NS),
            "MaxFailureRatio": spec.get("UpdateConfig", {}).get("MaxFailureRatio", 0),
            "Order": "start-first",
        }
        spec["RollbackConfig"] = {
            "Parallelism": 1,
            "Delay": spec.get("RollbackConfig", {}).get("Delay", STEP_DELAY_NS),
            "FailureAction": spec.get("RollbackConfig", {}).get("FailureAction", "pause"),
            "Monitor": spec.get("RollbackConfig", {}).get("Monitor", STEP_MONITOR_NS),
            "MaxFailureRatio": spec.get("RollbackConfig", {}).get("MaxFailureRatio", 0),
            "Order": spec.get("RollbackConfig", {}).get("Order", "stop-first"),
        }

        force_update = task_template.get("ForceUpdate", 0) + 1
        container_spec["Image"] = image
        task_template["ForceUpdate"] = force_update
        task_template["ContainerSpec"] = container_spec
        spec["TaskTemplate"] = task_template

        svc = docker.services.get(service["ID"])
        await svc.update(version=version_index, spec=spec)
    finally:
        await docker.close()


# ── Release cache ────────────────────────────────────────────

_release_cache: dict[str, Any] | None = None
_release_cache_time: float = 0
_release_lock = asyncio.Lock()


async def _fetch_latest_release(
    force: bool = False,
) -> LatestReleaseInfo | None:
    global _release_cache, _release_cache_time

    if (
        not force
        and _release_cache is not None
        and (time.time() - _release_cache_time) < UPDATE_CACHE_TTL_S
    ):
        return _release_cache  # type: ignore[return-value]

    async with _release_lock:
        # Double-check after acquiring lock
        if (
            not force
            and _release_cache is not None
            and (time.time() - _release_cache_time) < UPDATE_CACHE_TTL_S
        ):
            return _release_cache  # type: ignore[return-value]

        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                GITHUB_RELEASES_URL,
                headers={
                    "Accept": "application/vnd.github+json",
                    "User-Agent": "ClawBuddy-Updater",
                },
            )
            if not resp.is_success:
                raise RuntimeError(
                    f"GitHub release lookup failed with {resp.status_code}"
                )

            data = resp.json()

        tag = data.get("tag_name")
        html_url = data.get("html_url")
        published_at = data.get("published_at")

        if not tag or not html_url or not published_at:
            return None

        release = LatestReleaseInfo(
            version=normalize_version(tag) or tag,
            name=(data.get("name") or "").strip() or normalize_version(tag) or tag,
            body=(data.get("body") or "").strip(),
            url=html_url,
            published_at=published_at,
        )
        _release_cache = release  # type: ignore[assignment]
        _release_cache_time = time.time()
        return release


# ── DB helpers ───────────────────────────────────────────────


async def _get_active_run(
    db: AsyncSession | None = None,
) -> AppUpdateRun | None:
    async def _query(session: AsyncSession) -> AppUpdateRun | None:
        result = await session.execute(
            select(AppUpdateRun)
            .where(AppUpdateRun.status.in_(["pending", "running"]))
            .order_by(AppUpdateRun.created_at.desc())
            .limit(1)
        )
        return result.scalar_one_or_none()

    if db:
        return await _query(db)
    async with async_session_factory() as session:
        return await _query(session)


async def _get_latest_visible_run() -> AppUpdateRun | None:
    async with async_session_factory() as db:
        active = await _get_active_run(db)
        if active:
            return active
        result = await db.execute(
            select(AppUpdateRun)
            .where(AppUpdateRun.status == "failed")
            .order_by(AppUpdateRun.created_at.desc())
            .limit(1)
        )
        return result.scalar_one_or_none()


async def _update_run(run_id: str, data: dict[str, Any]) -> AppUpdateRun:
    async with async_session_factory() as db:
        result = await db.execute(
            select(AppUpdateRun).where(AppUpdateRun.id == run_id)
        )
        run = result.scalar_one()
        for k, v in data.items():
            attr = _camel_to_snake(k)
            if v is not None or k in ("error", "phaseMessage", "completedAt"):
                setattr(run, attr, v)
        await db.commit()
        await db.refresh(run)
        return run


async def _update_run_progress(
    run_id: str,
    mutate: Any,  # Callable[[dict], dict]
    extra: dict[str, Any] | None = None,
) -> AppUpdateRun:
    async with async_session_factory() as db:
        result = await db.execute(
            select(AppUpdateRun).where(AppUpdateRun.id == run_id)
        )
        run = result.scalar_one()
        progress = mutate(_parse_progress(run.progress))
        run.progress = progress
        if extra:
            for k, v in extra.items():
                attr = _camel_to_snake(k)
                if v is not None or k in ("error", "phaseMessage", "completedAt"):
                    setattr(run, attr, v)
        await db.commit()
        await db.refresh(run)
        return run


async def _fail_run(run_id: str, message: str) -> None:
    def mutate(progress: dict[str, Any]) -> dict[str, Any]:
        for key in ("pullApi", "pullWeb"):
            if progress[key]["status"] == "running":
                progress[key] = {
                    "status": "error",
                    "progress": progress[key]["progress"],
                    "error": message,
                }
        for key in ("apiDeploy", "webDeploy"):
            if progress[key]["status"] != "done":
                progress[key] = {
                    "status": "error",
                    "progress": progress[key]["progress"],
                    "error": message,
                }
        return progress

    await _update_run_progress(
        run_id,
        mutate,
        extra={
            "status": "failed",
            "phase": "failed",
            "phaseMessage": message,
            "error": message,
            "completedAt": datetime.now(timezone.utc),
        },
    )


_running_executors: set[str] = set()


async def _refresh_observed_progress(run: AppUpdateRun) -> AppUpdateRun:
    api_service = await _get_service_by_name(API_SERVICE_NAME)
    web_service = await _get_service_by_name(WEB_SERVICE_NAME)

    def mutate(progress: dict[str, Any]) -> dict[str, Any]:
        progress["observed"] = {
            "apiVersion": extract_version_from_image(
                (api_service or {}).get("Spec", {}).get("TaskTemplate", {}).get("ContainerSpec", {}).get("Image")
            ),
            "apiUpdateState": (api_service or {}).get("UpdateStatus", {}).get("State"),
            "apiUpdateMessage": (api_service or {}).get("UpdateStatus", {}).get("Message"),
            "webVersion": extract_version_from_image(
                (web_service or {}).get("Spec", {}).get("TaskTemplate", {}).get("ContainerSpec", {}).get("Image")
            ),
            "webUpdateState": (web_service or {}).get("UpdateStatus", {}).get("State"),
            "webUpdateMessage": (web_service or {}).get("UpdateStatus", {}).get("Message"),
        }
        return progress

    return await _update_run_progress(run.id, mutate)


async def _run_accepted_update(run_id: str) -> None:
    if run_id in _running_executors:
        return
    _running_executors.add(run_id)

    try:
        support = await _get_install_support()
        if not support["supported"] or not support.get("apiService") or not support.get("webService"):
            raise RuntimeError(support.get("reason") or "This installation is not managed by ClawBuddy Swarm")

        async with async_session_factory() as db:
            result = await db.execute(
                select(AppUpdateRun).where(AppUpdateRun.id == run_id)
            )
            run = result.scalar_one()

        api_image = _build_target_image(
            support["apiService"], run.target_version, "ghcr.io/danield2g/clawbuddy-api"
        )
        web_image = _build_target_image(
            support["webService"], run.target_version, "ghcr.io/danield2g/clawbuddy-web"
        )

        await _update_run_progress(
            run_id,
            lambda p: {
                **p,
                "pullApi": {"status": "running", "progress": f"Pulling {api_image}"},
                "pullWeb": {"status": "pending", "progress": f"Waiting to pull {web_image}"},
                "apiDeploy": _create_step("Waiting for images to finish pulling"),
                "webDeploy": _create_step("Waiting for the API deployment"),
            },
            extra={
                "status": "running",
                "phase": "pulling-images",
                "phaseMessage": "Pulling release images",
            },
        )

        await _pull_image(api_image, lambda msg: _update_run_progress(
            run_id, lambda p: {**p, "pullApi": {"status": "running", "progress": msg}}
        ))

        await _update_run_progress(run_id, lambda p: {
            **p,
            "pullApi": {"status": "done", "progress": f"API image ready ({run.target_version})"},
            "pullWeb": {"status": "running", "progress": f"Pulling {web_image}"},
        })

        await _pull_image(web_image, lambda msg: _update_run_progress(
            run_id, lambda p: {**p, "pullWeb": {"status": "running", "progress": msg}}
        ))

        await _update_run_progress(run_id, lambda p: {
            **p,
            "pullWeb": {"status": "done", "progress": f"Web image ready ({run.target_version})"},
            "apiDeploy": {"status": "running", "progress": f"Deploying API {run.target_version}"},
        })

        await _update_service_image(support["apiService"], api_image)

        await _update_run_progress(
            run_id,
            lambda p: {
                **p,
                "apiDeploy": {
                    "status": "running",
                    "progress": "API update requested. Waiting for the new API task to become healthy",
                },
            },
            extra={
                "phase": "waiting-for-api",
                "phaseMessage": "Waiting for the new API task to become healthy",
            },
        )
    except Exception as exc:
        await _fail_run(run_id, _err_msg(exc))
    finally:
        _running_executors.discard(run_id)


async def _reconcile_waiting_for_api(run: AppUpdateRun) -> AppUpdateRun:
    api_service = await _get_service_by_name(API_SERVICE_NAME)
    web_service = await _get_service_by_name(WEB_SERVICE_NAME)

    api_failure = _get_service_failure(api_service)
    if api_failure:
        await _fail_run(run.id, api_failure)
        async with async_session_factory() as db:
            result = await db.execute(select(AppUpdateRun).where(AppUpdateRun.id == run.id))
            return result.scalar_one()

    current_build_version = _get_current_version_from_build()
    if current_build_version != run.target_version:
        await _refresh_observed_progress(run)
        async with async_session_factory() as db:
            result = await db.execute(select(AppUpdateRun).where(AppUpdateRun.id == run.id))
            return result.scalar_one()

    if not web_service:
        await _fail_run(run.id, "Web Swarm service is missing")
        async with async_session_factory() as db:
            result = await db.execute(select(AppUpdateRun).where(AppUpdateRun.id == run.id))
            return result.scalar_one()

    web_image = _build_target_image(
        web_service, run.target_version, "ghcr.io/danield2g/clawbuddy-web"
    )

    await _update_run_progress(
        run.id,
        lambda p: {
            **p,
            "apiDeploy": {"status": "done", "progress": f"API {run.target_version} is healthy"},
            "webDeploy": {"status": "running", "progress": f"Deploying web {run.target_version}"},
        },
        extra={
            "phase": "deploying-web",
            "phaseMessage": f"Deploying web {run.target_version}",
        },
    )

    await _update_service_image(web_service, web_image)

    await _update_run_progress(
        run.id,
        lambda p: {
            **p,
            "webDeploy": {
                "status": "running",
                "progress": "Web update requested. Waiting for the new frontend to respond",
            },
        },
        extra={
            "phase": "waiting-for-web",
            "phaseMessage": "Waiting for the new frontend to respond",
        },
    )

    await _refresh_observed_progress(run)
    async with async_session_factory() as db:
        result = await db.execute(select(AppUpdateRun).where(AppUpdateRun.id == run.id))
        return result.scalar_one()


async def _reconcile_waiting_for_web(run: AppUpdateRun) -> AppUpdateRun:
    web_service = await _get_service_by_name(WEB_SERVICE_NAME)
    web_failure = _get_service_failure(web_service)
    if web_failure:
        await _fail_run(run.id, web_failure)
        async with async_session_factory() as db:
            result = await db.execute(select(AppUpdateRun).where(AppUpdateRun.id == run.id))
            return result.scalar_one()

    await _refresh_observed_progress(run)

    if not _is_service_stable_at_target(web_service, run.target_version):
        async with async_session_factory() as db:
            result = await db.execute(select(AppUpdateRun).where(AppUpdateRun.id == run.id))
            return result.scalar_one()

    await _update_run_progress(
        run.id,
        lambda p: {
            **p,
            "webDeploy": {"status": "done", "progress": f"Web {run.target_version} is deployed"},
        },
        extra={
            "status": "completed",
            "phase": "completed",
            "phaseMessage": f"ClawBuddy {run.target_version} is ready",
            "completedAt": datetime.now(timezone.utc),
            "error": None,
        },
    )

    async with async_session_factory() as db:
        result = await db.execute(select(AppUpdateRun).where(AppUpdateRun.id == run.id))
        return result.scalar_one()


# ── Public service ───────────────────────────────────────────


class UpdateService:
    """Manages self-updating via Docker Swarm."""

    async def get_overview(
        self, force_release_refresh: bool = False
    ) -> dict[str, Any]:
        latest_release: LatestReleaseInfo | None = None
        try:
            latest_release = await _fetch_latest_release(force_release_refresh)
        except Exception as exc:
            logger.error(f"[Update] Failed to fetch latest release: {_err_msg(exc)}")

        active_run = await _get_latest_visible_run()
        if active_run and active_run.status in ("pending", "running"):
            active_run = await self.reconcile_active_run(active_run.id)

        support = await _get_install_support()

        from clawbuddy.services.settings_service import settings_service

        return {
            "supported": support["supported"] or UPDATE_FORCE,
            "supportReason": (
                None if support["supported"] or UPDATE_FORCE else support.get("reason")
            ),
            "currentVersion": await _get_current_installed_version(),
            "currentBuild": get_build_info(),
            "latestRelease": (
                {
                    "version": latest_release.version,
                    "name": latest_release.name,
                    "body": latest_release.body,
                    "url": latest_release.url,
                    "publishedAt": latest_release.published_at,
                }
                if latest_release
                else None
            ),
            "dismissedVersion": await settings_service.get_dismissed_update_version(),
            "activeRun": _serialize_run(active_run),
            "forceUpdate": UPDATE_FORCE,
        }

    async def force_check(self) -> dict[str, Any]:
        global _release_cache
        _release_cache = None
        return await self.get_overview(force_release_refresh=True)

    async def accept_latest_release(self) -> AppUpdateRun:
        support = await _get_install_support()
        if not support["supported"]:
            raise RuntimeError(
                support.get("reason")
                or "This installation does not support integrated updates"
            )

        latest = await _fetch_latest_release(force=True)
        if not latest:
            raise RuntimeError("No stable GitHub release is available right now")

        existing = await _get_active_run()
        if existing:
            if existing.target_version != latest.version:
                raise RuntimeError(
                    f"Another update is already in progress ({existing.target_version})"
                )
            if existing.phase in ("pending", "pulling-images"):
                asyncio.create_task(_run_accepted_update(existing.id))
            return existing

        # Mark previous failed runs for this version
        async with async_session_factory() as db:
            await db.execute(
                sa_update(AppUpdateRun)
                .where(
                    AppUpdateRun.status == "failed",
                    AppUpdateRun.target_version == latest.version,
                )
                .values(status="completed", phaseMessage="Superseded by retry")
            )
            await db.commit()

        current_version = await _get_current_installed_version()

        async with async_session_factory() as db:
            run = AppUpdateRun(
                status="running",
                phase="pending",
                current_version=current_version,
                target_version=latest.version,
                target_release_name=latest.name,
                target_release_url=latest.url,
                target_published_at=datetime.fromisoformat(
                    latest.published_at.replace("Z", "+00:00")
                ),
                target_release_notes=latest.body,
                phase_message="Preparing update",
                progress=_create_default_progress(),
                started_at=datetime.now(timezone.utc),
            )
            db.add(run)
            await db.commit()
            await db.refresh(run)

        from clawbuddy.services.settings_service import settings_service

        await settings_service.set_dismissed_update_version(None)

        asyncio.create_task(_run_accepted_update(run.id))
        return run

    async def decline_latest_release(self) -> str:
        latest = await _fetch_latest_release(force=True)
        if not latest:
            raise RuntimeError("No stable GitHub release is available right now")

        from clawbuddy.services.settings_service import settings_service

        await settings_service.set_dismissed_update_version(latest.version)
        return latest.version

    async def reconcile_active_run(
        self, run_id: str | None = None
    ) -> AppUpdateRun | None:
        if run_id:
            async with async_session_factory() as db:
                result = await db.execute(
                    select(AppUpdateRun).where(AppUpdateRun.id == run_id)
                )
                run = result.scalar_one_or_none()
        else:
            run = await _get_active_run()

        if not run or run.status not in ("pending", "running"):
            return run

        if run.phase in ("pending", "pulling-images"):
            asyncio.create_task(_run_accepted_update(run.id))
            return run

        if run.phase == "waiting-for-api":
            return await _reconcile_waiting_for_api(run)

        if run.phase in ("deploying-web", "waiting-for-web"):
            return await _reconcile_waiting_for_web(run)

        return run


update_service = UpdateService()
