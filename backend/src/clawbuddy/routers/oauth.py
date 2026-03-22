"""OAuth router — Google OAuth2 authorization flow for workspace capabilities.

Replaces: apps/api/src/routes/oauth.ts

Handles the Google OAuth2 authorization code flow:
1. /google/authorize — redirect to Google consent screen
2. /google/callback — exchange code for tokens, store credentials
3. /google/disconnect — remove credentials from workspace capability
"""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, Query
from fastapi.responses import RedirectResponse
from loguru import logger
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from clawbuddy.db.models import Capability, WorkspaceCapability
from clawbuddy.db.session import get_db
from clawbuddy.lib.responses import fail
from clawbuddy.services.config_validation import encrypt_config_fields
from clawbuddy.services.crypto import decrypt, encrypt
from clawbuddy.settings import settings as env

router = APIRouter(tags=["oauth"])

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"

SCOPES = " ".join(
    [
        "https://mail.google.com/",
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/calendar",
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/userinfo.email",
    ]
)


def _get_redirect_uri() -> str:
    app_url = env.APP_URL or "http://localhost:4321"
    return f"{app_url}/api/oauth/google/callback"


async def _get_google_credentials() -> dict[str, str]:
    from clawbuddy.services.settings_service import settings_service

    creds = await settings_service.get_google_credentials()
    if not creds:
        raise RuntimeError("Google OAuth client credentials not configured")
    return {"clientId": creds["clientId"], "clientSecret": creds["clientSecret"]}


@router.get("/google/authorize")
async def google_authorize(
    workspaceId: str | None = None,
    capabilitySlug: str | None = None,
) -> RedirectResponse:
    """Initiate Google OAuth2 authorization flow."""
    if not workspaceId or not capabilitySlug:
        return RedirectResponse(
            "/settings/capabilities?oauth=error&message=workspaceId+and+capabilitySlug+are+required",
            status_code=302,
        )

    creds = await _get_google_credentials()

    # Encrypt state to prevent tampering
    state = encrypt(json.dumps({"workspaceId": workspaceId, "capabilitySlug": capabilitySlug}))

    params = urlencode(
        {
            "client_id": creds["clientId"],
            "redirect_uri": _get_redirect_uri(),
            "response_type": "code",
            "scope": SCOPES,
            "access_type": "offline",
            "prompt": "consent",
            "state": state,
        }
    )

    return RedirectResponse(f"{GOOGLE_AUTH_URL}?{params}", status_code=302)


@router.get("/google/callback")
async def google_callback(
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    db: AsyncSession = Depends(get_db),
) -> RedirectResponse:
    """Handle Google OAuth2 callback — exchange code for tokens."""
    if error:
        return RedirectResponse(
            f"/settings/capabilities?oauth=error&message={error}",
            status_code=302,
        )

    if not code or not state:
        return RedirectResponse(
            "/settings/capabilities?oauth=error&message=Missing+code+or+state",
            status_code=302,
        )

    # Decrypt state
    try:
        state_data = json.loads(decrypt(state))
        workspace_id = state_data["workspaceId"]
        capability_slug = state_data["capabilitySlug"]
    except Exception:
        return RedirectResponse(
            "/settings/capabilities?oauth=error&message=Invalid+state",
            status_code=302,
        )

    creds = await _get_google_credentials()

    # Exchange code for tokens
    async with httpx.AsyncClient(timeout=15) as client:
        token_resp = await client.post(
            GOOGLE_TOKEN_URL,
            data={
                "code": code,
                "client_id": creds["clientId"],
                "client_secret": creds["clientSecret"],
                "redirect_uri": _get_redirect_uri(),
                "grant_type": "authorization_code",
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )

    if not token_resp.is_success:
        logger.error(f"[OAuth] Token exchange failed: {token_resp.text}")
        return RedirectResponse(
            "/settings/capabilities?oauth=error&message=Token+exchange+failed",
            status_code=302,
        )

    tokens = token_resp.json()
    refresh_token = tokens.get("refresh_token")
    access_token = tokens.get("access_token")

    if not refresh_token:
        return RedirectResponse(
            "/settings/capabilities?oauth=error&message=No+refresh+token.+Try+revoking+access+at+myaccount.google.com",
            status_code=302,
        )

    # Fetch user email
    email = "unknown"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            user_resp = await client.get(
                GOOGLE_USERINFO_URL,
                headers={"Authorization": f"Bearer {access_token}"},
            )
            if user_resp.is_success:
                email = user_resp.json().get("email", "unknown")
    except Exception:
        pass  # Non-critical

    # Build GWS CLI credentials file content
    gws_credentials = json.dumps(
        {
            "client_id": creds["clientId"],
            "client_secret": creds["clientSecret"],
            "refresh_token": refresh_token,
            "type": "authorized_user",
        }
    )

    # Store in WorkspaceCapability.config
    cap_result = await db.execute(
        select(Capability).where(Capability.slug == capability_slug)
    )
    capability = cap_result.scalar_one_or_none()

    if not capability:
        return RedirectResponse(
            "/settings/capabilities?oauth=error&message=Capability+not+found",
            status_code=302,
        )

    schema = capability.config_schema or []
    config = encrypt_config_fields(
        schema,
        {"gwsCredentialsFile": gws_credentials, "email": email},
    )

    # Upsert workspace capability
    wc_result = await db.execute(
        select(WorkspaceCapability).where(
            WorkspaceCapability.workspace_id == workspace_id,
            WorkspaceCapability.capability_id == capability.id,
        )
    )
    wc = wc_result.scalar_one_or_none()

    if wc:
        wc.enabled = True
        wc.config = config
    else:
        wc = WorkspaceCapability(
            workspace_id=workspace_id,
            capability_id=capability.id,
            enabled=True,
            config=config,
        )
        db.add(wc)

    await db.commit()

    # Destroy active sandboxes so they pick up new credentials
    from clawbuddy.db.models import SandboxSession

    sandbox_result = await db.execute(
        select(SandboxSession).where(
            SandboxSession.workspace_id == workspace_id,
            SandboxSession.status == "running",
        )
    )
    sandboxes = sandbox_result.scalars().all()

    if sandboxes:
        from clawbuddy.services.sandbox import sandbox_service

        for s in sandboxes:
            try:
                await sandbox_service.destroy_sandbox(s.id, db)
            except Exception:
                pass

    # Stop workspace container so it recreates with new env
    try:
        from clawbuddy.services.sandbox import sandbox_service

        await sandbox_service.stop_workspace_container(workspace_id, db)
    except Exception:
        pass

    return RedirectResponse(
        f"/workspaces/{workspace_id}?oauth=success", status_code=302
    )


@router.delete("/google/disconnect")
async def google_disconnect(
    body: dict[str, Any],
    db: AsyncSession = Depends(get_db),
) -> Any:
    """Disconnect Google OAuth from a workspace capability."""
    workspace_id = body.get("workspaceId")
    capability_slug = body.get("capabilitySlug")

    if not workspace_id or not capability_slug:
        return fail("workspaceId and capabilitySlug are required")

    cap_result = await db.execute(
        select(Capability).where(Capability.slug == capability_slug)
    )
    capability = cap_result.scalar_one_or_none()

    if not capability:
        return fail("Capability not found", status_code=404)

    # Update workspace capability — clear config and disable
    wc_result = await db.execute(
        select(WorkspaceCapability).where(
            WorkspaceCapability.workspace_id == workspace_id,
            WorkspaceCapability.capability_id == capability.id,
        )
    )
    wc = wc_result.scalar_one_or_none()

    if wc:
        wc.config = None
        wc.enabled = False
        await db.commit()

    # Stop workspace container so it restarts without GWS credentials
    try:
        from clawbuddy.services.sandbox import sandbox_service

        await sandbox_service.stop_workspace_container(workspace_id, db)
    except Exception:
        pass

    from fastapi.responses import ORJSONResponse

    return ORJSONResponse({"success": True})
