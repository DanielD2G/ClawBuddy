"""Browser router — manage browser configuration and sessions.

Replaces: apps/api/src/routes/browser.ts
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from clawbuddy.lib.responses import fail, ok
from clawbuddy.services.browser import browser_service

router = APIRouter(tags=["browser"])


@router.get("/config")
async def get_browser_config() -> Any:
    """Get current browser configuration."""
    from clawbuddy.services.settings_service import settings_service

    url = await settings_service.get_browser_grid_url()
    browser = await settings_service.get_browser_grid_browser()
    browser_model = await settings_service.get_browser_model()
    api_key = await settings_service.get_browser_grid_api_key()

    return ok(
        {
            "url": url,
            "hasApiKey": bool(api_key),
            "browser": browser,
            "browserModel": browser_model,
        }
    )


@router.patch("/config")
async def update_browser_config(body: dict[str, Any]) -> Any:
    """Update browser configuration."""
    from clawbuddy.services.settings_service import settings_service

    url = body.get("url")
    api_key = body.get("apiKey")
    browser = body.get("browser")
    browser_model = body.get("browserModel")

    # Validate browser type
    if browser and browser not in ("chromium", "firefox", "camoufox"):
        return fail(
            'Invalid browser. Must be "chromium", "firefox", or "camoufox".',
            status_code=400,
        )

    # Update non-sensitive settings
    update_data: dict[str, Any] = {}
    if url:
        update_data["browserGridUrl"] = url
    if browser:
        update_data["browserGridBrowser"] = browser
    if browser_model is not None:
        update_data["browserModel"] = browser_model or None

    if update_data:
        await settings_service.update(update_data)

    # Handle API key separately (encrypted)
    if api_key is not None:
        await settings_service.set_browser_grid_api_key(
            "" if api_key == "" else api_key
        )

    return ok(None)


@router.get("/health")
async def browser_health() -> Any:
    """Check BrowserGrid health."""
    try:
        healthy = await browser_service.health_check()
        return ok({"healthy": healthy})
    except Exception:
        return ok({"healthy": False})


@router.get("/sessions")
async def list_browser_sessions() -> Any:
    """List active browser sessions."""
    sessions = browser_service.get_active_sessions()
    return ok({"sessions": sessions})


@router.delete("/sessions/{session_id}")
async def close_browser_session(session_id: str) -> Any:
    """Close a browser session."""
    await browser_service.close_session(session_id)
    return ok(None)
