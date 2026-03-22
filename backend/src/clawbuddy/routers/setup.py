"""Setup/onboarding routes.

Replaces: apps/api/src/routes/setup.ts
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
from fastapi import APIRouter, Depends
from loguru import logger
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from clawbuddy.db.models import Capability, WorkspaceCapability
from clawbuddy.db.session import get_db
from clawbuddy.lib.responses import fail, ok
from clawbuddy.schemas.workspace_export import WorkspaceExport
from clawbuddy.services.model_discovery import (
    discover_embedding_models,
    discover_llm_models,
    invalidate_model_cache,
    test_provider_connection,
)
from clawbuddy.services.provider_state import build_provider_state
from clawbuddy.services.settings_service import settings_service
from clawbuddy.services.workspace import workspace_service
from clawbuddy.settings import settings as env

router = APIRouter(tags=["Setup"])

# ── Docker image task state ────────────────────────────────
_image_state: dict[str, dict[str, str]] = {
    "sandbox": {"status": "idle", "progress": ""},
}


def _overall_status() -> dict[str, Any]:
    sb = _image_state["sandbox"]
    return {"status": sb["status"], "sandbox": sb}


async def _require_setup_incomplete() -> dict[str, Any] | None:
    s = await settings_service.get()
    if s.get("onboardingComplete"):
        return fail("Setup already completed", status_code=400)
    return None


# ── Routes ─────────────────────────────────────────────────

@router.get("/status")
async def setup_status() -> dict[str, Any]:
    s = await settings_service.get()
    return ok({"onboardingComplete": s.get("onboardingComplete", False)})


@router.get("/settings")
async def setup_settings() -> dict[str, Any]:
    blocked = await _require_setup_incomplete()
    if blocked:
        return blocked
    return ok(
        {
            "providers": await build_provider_state(),
            "browserGridFromEnv": bool(env.BROWSER_GRID_URL),
        }
    )


@router.patch("/settings")
async def update_setup_settings(body: dict[str, Any]) -> dict[str, Any]:
    blocked = await _require_setup_incomplete()
    if blocked:
        return blocked

    update_data: dict[str, Any] = {}
    field_map = {
        "llm": "aiProvider",
        "llmModel": "aiModel",
        "mediumModel": "mediumModel",
        "lightModel": "lightModel",
        "embedding": "embeddingProvider",
        "embeddingModel": "embeddingModel",
        "advancedModelConfig": "advancedModelConfig",
        "exploreModel": "exploreModel",
        "executeModel": "executeModel",
        "titleModel": "titleModel",
        "compactModel": "compactModel",
        "roleProviders": "roleProviders",
    }
    for body_key, data_key in field_map.items():
        if body_key in body:
            update_data[data_key] = body[body_key]

    s = await settings_service.update(update_data)
    role_providers = await settings_service.get_resolved_role_providers()

    return ok(
        {
            "active": {
                "llm": s.get("aiProvider"),
                "llmModel": s.get("aiModel"),
                "mediumModel": s.get("mediumModel"),
                "lightModel": s.get("lightModel"),
                "exploreModel": s.get("exploreModel"),
                "executeModel": s.get("executeModel"),
                "titleModel": s.get("titleModel"),
                "compactModel": s.get("compactModel"),
                "roleProviders": role_providers,
                "embedding": s.get("embeddingProvider"),
                "embeddingModel": s.get("embeddingModel"),
            },
        }
    )


@router.get("/capabilities")
async def setup_capabilities(db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    result = await db.execute(
        select(
            Capability.slug,
            Capability.name,
            Capability.description,
            Capability.category,
            Capability.config_schema,
        ).order_by(Capability.slug.asc())
    )
    capabilities = [dict(row._mapping) for row in result.all()]
    return ok(capabilities)


@router.put("/provider-connections/{provider}")
async def set_provider_connection(
    provider: str,
    body: dict[str, Any],
) -> dict[str, Any]:
    blocked = await _require_setup_incomplete()
    if blocked:
        return blocked

    value = body.get("value")
    if not value or not isinstance(value, str):
        return fail("value is required", status_code=400)

    await settings_service.set_provider_connection(provider, value)
    invalidate_model_cache(provider)

    return ok(
        {
            "connections": await settings_service.get_provider_connections(),
            "providers": await build_provider_state(),
        }
    )


@router.delete("/provider-connections/{provider}")
async def remove_provider_connection(provider: str) -> dict[str, Any]:
    blocked = await _require_setup_incomplete()
    if blocked:
        return blocked

    await settings_service.remove_provider_connection(provider)
    invalidate_model_cache(provider)

    return ok(
        {
            "connections": await settings_service.get_provider_connections(),
            "providers": await build_provider_state(),
        }
    )


@router.post("/provider-connections/{provider}/test")
async def test_provider(provider: str, body: dict[str, Any]) -> dict[str, Any]:
    blocked = await _require_setup_incomplete()
    if blocked:
        return blocked

    value = body.get("value", "")
    result = await test_provider_connection(provider, value)
    return ok(result.to_dict())


@router.get("/google-oauth")
async def google_oauth_status() -> dict[str, Any]:
    return ok({"configured": settings_service.is_google_oauth_configured()})


@router.post("/google-oauth/test")
async def test_google_oauth() -> dict[str, Any]:
    creds = await settings_service.get_google_credentials()
    if not creds:
        return fail("Google OAuth credentials not configured", status_code=400)

    result: dict[str, Any] = {"valid": False}

    # 1. Validate client credentials via dummy token exchange
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                "https://oauth2.googleapis.com/token",
                data={
                    "code": "test_dummy_code",
                    "client_id": creds["clientId"],
                    "client_secret": creds["clientSecret"],
                    "redirect_uri": "http://localhost",
                    "grant_type": "authorization_code",
                },
            )
            data = resp.json()

        if data.get("error") == "invalid_client":
            result["message"] = "Invalid Client ID or Client Secret"
            return ok(result)
        if data.get("error") not in ("invalid_grant", "redirect_uri_mismatch"):
            result["message"] = data.get("error_description") or data.get("error") or "Unknown error"
            return ok(result)
    except Exception:
        result["message"] = "Could not reach Google servers"
        return ok(result)

    result["valid"] = True

    # 2. Find a connected workspace with a refresh token to test API access
    from clawbuddy.db.session import get_db_context
    from clawbuddy.services.config_validation import decrypt_config_fields

    async with get_db_context() as db:
        cap_result = await db.execute(
            select(Capability).where(Capability.slug == "google-workspace")
        )
        gws_cap = cap_result.scalar_one_or_none()
        if not gws_cap:
            return ok(result)

        wc_result = await db.execute(
            select(WorkspaceCapability).where(
                WorkspaceCapability.capability_id == gws_cap.id,
                WorkspaceCapability.enabled == True,
                WorkspaceCapability.config.isnot(None),
            ).limit(1)
        )
        connected_wc = wc_result.scalar_one_or_none()
        if not connected_wc or not connected_wc.config:
            return ok(result)

        schema = gws_cap.config_schema or []
        decrypted = decrypt_config_fields(schema, connected_wc.config)

        if not decrypted.get("gwsCredentialsFile"):
            return ok(result)

        result["connectedEmail"] = decrypted.get("email")

        # 3. Refresh the access token
        import json

        try:
            cred_data = json.loads(decrypted["gwsCredentialsFile"])
            async with httpx.AsyncClient(timeout=10.0) as client:
                token_resp = await client.post(
                    "https://oauth2.googleapis.com/token",
                    data={
                        "client_id": creds["clientId"],
                        "client_secret": creds["clientSecret"],
                        "refresh_token": cred_data["refresh_token"],
                        "grant_type": "refresh_token",
                    },
                )
                token_data = token_resp.json()

            if not token_data.get("access_token"):
                result["message"] = f"Token refresh failed: {token_data.get('error_description') or token_data.get('error')}"
                result["valid"] = False
                return ok(result)
            access_token = token_data["access_token"]
        except Exception:
            return ok(result)

        # 4. Test each API
        api_tests = {
            "gmail": "https://gmail.googleapis.com/gmail/v1/users/me/profile",
            "calendar": "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1",
            "drive": "https://www.googleapis.com/drive/v3/about?fields=user",
        }
        apis: dict[str, bool] = {}
        async with httpx.AsyncClient(timeout=10.0) as client:
            for name, url in api_tests.items():
                try:
                    r = await client.get(url, headers={"Authorization": f"Bearer {access_token}"})
                    apis[name] = r.is_success
                except Exception:
                    apis[name] = False
        result["apis"] = apis

    return ok(result)


# ── Docker image preparation ──────────────────────────────

@router.post("/pull-images")
async def pull_images() -> dict[str, Any]:
    if _image_state["sandbox"]["status"] != "pulling":

        async def _pull() -> None:
            _image_state["sandbox"] = {"status": "pulling", "progress": "Checking base image..."}
            try:
                from clawbuddy.services.image_builder import image_builder_service

                def on_progress(line: str) -> None:
                    _image_state["sandbox"] = {"status": "pulling", "progress": line}

                await image_builder_service.ensure_base_image(on_progress)
                _image_state["sandbox"] = {"status": "done", "progress": "Base image ready"}
            except Exception as err:
                _image_state["sandbox"] = {
                    "status": "error",
                    "progress": "",
                    "error": str(err),
                }

        asyncio.create_task(_pull())

    return ok(_overall_status())


@router.get("/pull-images/status")
async def pull_images_status() -> dict[str, Any]:
    return ok(_overall_status())


# ── Preflight checks ──────────────────────────────────────

@router.post("/preflight")
async def preflight(body: dict[str, Any]) -> dict[str, Any]:
    blocked = await _require_setup_incomplete()
    if blocked:
        return blocked

    selected_caps = set(body.get("capabilities") or [])
    browser_grid_url = body.get("browserGridUrl")
    s = await settings_service.get()

    checks: list[dict[str, Any]] = []

    async def run_check(
        name: str,
        fn: Any,
        condition: bool = True,
    ) -> None:
        if not condition:
            checks.append({"name": name, "status": "skip", "message": "Not configured", "durationMs": 0})
            return
        import time
        start = time.monotonic()
        try:
            result = await fn()
            checks.append({"name": name, **result, "durationMs": int((time.monotonic() - start) * 1000)})
        except Exception as err:
            msg = str(err)
            logger.error(f"[Preflight] {name} failed ({int((time.monotonic() - start) * 1000)}ms): {msg}")
            checks.append({"name": name, "status": "fail", "message": msg, "durationMs": int((time.monotonic() - start) * 1000)})

    # 1. AI Providers
    configured = await settings_service.get_configured_providers()
    metadata = settings_service.get_provider_metadata()

    for provider in configured["llm"]:
        label = metadata.get(provider, {}).get("label", provider)

        async def _check_provider(p: str = provider, l: str = label) -> dict[str, str]:
            models = await discover_llm_models(p)
            if not models:
                return {"status": "fail", "message": f"No models discovered for {p}"}
            return {"status": "pass", "message": f"{l} credentials are valid ({len(models)} models available)"}

        await run_check(f"{label} Connection", _check_provider)

    # 2. Embedding Provider
    async def _check_embedding() -> dict[str, str]:
        ep = s.get("embeddingProvider", "openai")
        cv = await settings_service.get_provider_connection_value(ep)
        if not cv:
            return {"status": "fail", "message": f"No connection for {ep}"}
        models = await discover_embedding_models(ep)
        if not models:
            return {"status": "fail", "message": f"No embedding models discovered for {ep}"}
        return {"status": "pass", "message": f"{ep} credentials are valid ({len(models)} embedding models available)"}

    await run_check("Embedding Provider", _check_embedding)

    # 3. Qdrant
    async def _check_qdrant() -> dict[str, str]:
        from clawbuddy.lib.qdrant import qdrant
        collections = await qdrant.get_collections()
        return {"status": "pass", "message": f"Connected — {len(collections.collections)} collections"}

    await run_check("Qdrant", _check_qdrant)

    # 4. S3/MinIO
    async def _check_s3() -> dict[str, str]:
        from clawbuddy.lib.s3 import get_s3_client
        async with get_s3_client() as s3:
            result = await s3.list_buckets()
            bucket_names = [b["Name"] for b in result.get("Buckets", [])]
            has_bucket = env.MINIO_BUCKET in bucket_names
            return {
                "status": "pass",
                "message": (
                    f'Connected — bucket "{env.MINIO_BUCKET}" exists'
                    if has_bucket
                    else f'Connected — bucket "{env.MINIO_BUCKET}" will be created'
                ),
            }

    await run_check("Object Storage (S3)", _check_s3)

    # 5. Google OAuth
    async def _check_google_oauth() -> dict[str, str]:
        gcreds = await settings_service.get_google_credentials()
        if not gcreds:
            return {"status": "fail", "message": "Credentials not found"}
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                "https://oauth2.googleapis.com/token",
                data={
                    "code": "test_dummy_code",
                    "client_id": gcreds["clientId"],
                    "client_secret": gcreds["clientSecret"],
                    "redirect_uri": "http://localhost",
                    "grant_type": "authorization_code",
                },
            )
            data = resp.json()
        if data.get("error") == "invalid_client":
            return {"status": "fail", "message": "Invalid Client ID or Client Secret"}
        return {"status": "pass", "message": "Client credentials are valid"}

    await run_check("Google OAuth", _check_google_oauth, settings_service.is_google_oauth_configured())

    # 6. BrowserGrid
    async def _check_browser_grid() -> dict[str, str]:
        url = env.BROWSER_GRID_URL or browser_grid_url or "http://localhost:9090"
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{url}/api/health")
        if resp.status_code != 200:
            return {"status": "fail", "message": f"Health check returned {resp.status_code}"}
        return {"status": "pass", "message": f"Reachable at {url}"}

    await run_check("BrowserGrid", _check_browser_grid, "browser-automation" in selected_caps)

    # 7. Docker
    async def _check_docker() -> dict[str, str]:
        import aiodocker
        docker = aiodocker.Docker()
        try:
            info = await docker.system.info()
            return {"status": "pass", "message": f"Docker {info.get('ServerVersion', '?')} — {info.get('Containers', 0)} containers"}
        finally:
            await docker.close()

    await run_check("Docker", _check_docker)

    # 8. Sandbox Base Image
    async def _check_sandbox_image() -> dict[str, str]:
        import aiodocker
        docker = aiodocker.Docker()
        try:
            img = await docker.images.inspect("clawbuddy-sandbox-base")
            size_mb = round((img.get("Size", 0)) / 1024 / 1024)
            return {"status": "pass", "message": f"Image ready ({size_mb}MB)"}
        except aiodocker.exceptions.DockerError:
            return {"status": "fail", "message": "Base image not found — build it in the Docker step"}
        finally:
            await docker.close()

    await run_check("Sandbox Base Image", _check_sandbox_image)

    # 9. Sandbox Spin-up
    async def _check_sandbox_spinup() -> dict[str, str]:
        import aiodocker
        docker = aiodocker.Docker()
        try:
            image = "clawbuddy-sandbox-base"
            try:
                await docker.images.inspect(image)
            except aiodocker.exceptions.DockerError:
                image = "ubuntu:22.04"
                try:
                    await docker.images.inspect(image)
                except aiodocker.exceptions.DockerError:
                    return {"status": "fail", "message": "No sandbox image available to test"}

            config = {
                "Image": image,
                "Cmd": ["echo", "preflight-ok"],
                "HostConfig": {
                    "Memory": 64 * 1024 * 1024,
                    "NanoCpus": 500_000_000,
                    "NetworkMode": "none",
                    "AutoRemove": True,
                },
                "Labels": {"clawbuddy.type": "preflight-test"},
            }
            container = await docker.containers.create_or_replace("preflight-test", config)
            await container.start()
            result = await container.wait()
            exit_code = result.get("StatusCode", -1)
            if exit_code != 0:
                return {"status": "fail", "message": f"Container exited with code {exit_code}"}
            return {"status": "pass", "message": "Container started and executed successfully"}
        finally:
            await docker.close()

    await run_check("Sandbox Spin-up", _check_sandbox_spinup)

    all_passed = all(c["status"] in ("pass", "skip") for c in checks)
    return ok({"checks": checks, "allPassed": all_passed})


# ── Import workspace config during setup ──────────────────

@router.post("/import")
async def import_during_setup(body: dict[str, Any]) -> dict[str, Any]:
    blocked = await _require_setup_incomplete()
    if blocked:
        return blocked

    parsed = WorkspaceExport.model_validate(body)
    mc = parsed.model_config_data

    try:
        if mc.local_base_url and mc.local_base_url.strip():
            await settings_service.set_provider_connection("local", mc.local_base_url)
            invalidate_model_cache("local")

        update_data: dict[str, Any] = {
            "aiProvider": mc.ai_provider,
        }
        if mc.ai_model:
            update_data["aiModel"] = mc.ai_model
        if mc.role_providers:
            update_data["roleProviders"] = mc.role_providers
        for field in ("mediumModel", "lightModel", "exploreModel", "executeModel", "titleModel", "compactModel"):
            val = getattr(mc, field.replace("M", "_m").replace("m_", "m"), None)
            if val is not None:
                update_data[field] = val
        if mc.advanced_model_config is not None:
            update_data["advancedModelConfig"] = mc.advanced_model_config
        update_data["embeddingProvider"] = mc.embedding_provider
        if mc.embedding_model:
            update_data["embeddingModel"] = mc.embedding_model
        if mc.context_limit_tokens is not None:
            update_data["contextLimitTokens"] = mc.context_limit_tokens
        if mc.max_agent_iterations is not None:
            update_data["maxAgentIterations"] = mc.max_agent_iterations
        if mc.timezone:
            update_data["timezone"] = mc.timezone

        await settings_service.update(update_data)
    except Exception:
        pass

    return ok(
        {
            "workspace": parsed.workspace.model_dump(by_alias=True),
            "capabilities": [c.model_dump(by_alias=True) for c in parsed.capabilities],
            "channels": [c.model_dump(by_alias=True) for c in parsed.channels],
            "modelConfig": mc.model_dump(by_alias=True),
        }
    )


# ── Complete onboarding ────────────────────────────────────

@router.post("/complete")
async def complete_setup(
    body: dict[str, Any],
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    blocked = await _require_setup_incomplete()
    if blocked:
        return blocked

    from clawbuddy.db.models import Workspace
    from clawbuddy.services.capability import capability_service
    from clawbuddy.services.embedding import embedding_service
    from clawbuddy.services.search import search_service

    # Apply chat model config before validation
    model_update: dict[str, Any] = {}
    field_map = {
        "llm": "aiProvider", "llmModel": "aiModel",
        "mediumModel": "mediumModel", "lightModel": "lightModel",
        "exploreModel": "exploreModel", "executeModel": "executeModel",
        "titleModel": "titleModel", "compactModel": "compactModel",
        "advancedModelConfig": "advancedModelConfig", "roleProviders": "roleProviders",
    }
    for body_key, data_key in field_map.items():
        if body_key in body:
            model_update[data_key] = body[body_key]
    if model_update:
        await settings_service.update(model_update)

    s = await settings_service.get()
    available = await settings_service.get_available_providers()

    # Validate embedding provider
    ep = s.get("embeddingProvider", "openai")
    if ep not in available["embedding"]:
        return fail(f'Embedding provider "{ep}" is not available', status_code=400)

    # Validate AI provider
    ai_p = s.get("aiProvider", "openai")
    if ai_p not in available["llm"]:
        return fail(f'AI provider "{ai_p}" is not available', status_code=400)
    if not s.get("aiModel"):
        return fail("Select a primary AI model before completing setup", status_code=400)

    # Create Qdrant collection
    vector = await embedding_service.embed("setup dimension probe")
    await search_service.ensure_collection(len(vector))

    # Create workspace
    workspace = Workspace(
        name=body.get("workspaceName") or "Default",
        color=body.get("workspaceColor"),
    )
    db.add(workspace)
    await db.commit()
    await db.refresh(workspace)

    # Save timezone
    if "timezone" in body:
        await settings_service.update({"timezone": body["timezone"]})

    # Mark onboarding complete
    await settings_service.complete_onboarding()

    # Enable base capabilities
    base_slugs = [
        "document-search", "bash", "agent-memory", "cron-management",
        "python", "web-fetch", "sub-agent-delegation",
    ]

    # Auto-enable capabilities whose required API key is available
    if hasattr(capability_service, "REQUIRES_API_KEY"):
        for slug, provider in capability_service.REQUIRES_API_KEY.items():
            key = await settings_service.get_api_key(provider)
            if key and slug not in base_slugs:
                base_slugs.append(slug)

    for slug in base_slugs:
        try:
            await capability_service.enable_capability(db, workspace.id, slug)
        except Exception:
            pass

    # Enable additional selected capabilities
    capabilities = body.get("capabilities") or []
    capability_configs = body.get("capabilityConfigs") or {}
    for slug in capabilities:
        if slug in base_slugs:
            continue
        try:
            config = capability_configs.get(slug)
            await capability_service.enable_capability(db, workspace.id, slug, config)
        except Exception:
            pass

    # Create Telegram channel if token provided
    telegram_token = body.get("telegramBotToken")
    if telegram_token and isinstance(telegram_token, str):
        from clawbuddy.services.channel import channel_service

        channel = await channel_service.create(
            db,
            workspace_id=workspace.id,
            channel_type="telegram",
            name="Telegram",
            config={"botToken": telegram_token},
        )

        if body.get("telegramTokenTested"):
            try:
                from clawbuddy.channels.telegram.bot_manager import telegram_bot_manager

                bot_username = await telegram_bot_manager.start_bot(
                    channel.id, telegram_token, workspace.id
                )
                await channel_service.update(db, channel.id, {"config": {"botUsername": bot_username}})
                await channel_service.enable(db, channel.id)
            except Exception as err:
                logger.error(f"[Setup] Failed to auto-enable Telegram channel: {err}")

    # Index capabilities (non-blocking)
    async def _index() -> None:
        try:
            from clawbuddy.services.tool_discovery import tool_discovery_service
            await tool_discovery_service.index_capabilities()
        except Exception as err:
            logger.error(f"[Setup] Failed to index capabilities: {err}")

    asyncio.create_task(_index())

    return ok(
        {
            "onboardingComplete": True,
            "workspace": workspace_service.serialize(workspace),
        }
    )
