"""Browser service — BrowserGrid + Playwright session management.

Replaces: apps/api/src/services/browser.service.ts

Manages browser sessions via a BrowserGrid proxy that provides
remote Playwright browsers. Each chat session gets its own browser
context for isolation. Sessions are cleaned up when idle.

The BrowserGrid SDK is replaced by direct HTTP/WebSocket calls via httpx
and playwright.async_api.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Coroutine

import httpx
from loguru import logger
from playwright.async_api import (
    BrowserContext,
    Page,
    async_playwright,
    Playwright,
)

from clawbuddy.constants import (
    BROWSER_ACTION_TIMEOUT_MS,
    BROWSER_HEALTH_TIMEOUT_MS,
    BROWSER_IDLE_TIMEOUT_MS,
    BROWSER_NAV_TIMEOUT_MS,
    BROWSER_SCRIPT_DEFAULT_TIMEOUT_S,
    BROWSER_SCRIPT_MAX_TIMEOUT_S,
    BROWSER_SCRIPT_MIN_TIMEOUT_S,
    ELEMENT_TEXT_MAX_LEN,
    LINK_TEXT_MAX_LEN,
    MAX_INTERACTIVE_ELEMENTS,
    MAX_LINKS,
    MAX_READABLE_CONTENT_BYTES,
    SCREENSHOT_JPEG_QUALITY,
    SELECTOR_TEXT_MAX_LEN,
)


@dataclass
class BrowserSession:
    """Tracks an active browser session."""

    context: BrowserContext
    page: Page
    chat_session_id: str
    last_activity_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    close_fn: Callable[[], Coroutine[Any, Any, None]] | None = None


@dataclass
class ScriptResult:
    """Result of executing a browser script."""

    success: bool
    result: str | None = None
    error: str | None = None
    screenshot_base64: str | None = None


@dataclass
class InteractiveElement:
    """An interactive element discovered on a page."""

    tag: str
    text: str
    selector: str
    type: str | None = None
    placeholder: str | None = None
    role: str | None = None
    value: str | None = None


async def capture_optimized_screenshot(
    page: Page,
    *,
    full_page: bool = False,
) -> str | None:
    """Capture a JPEG screenshot optimized for LLM consumption.

    Returns base64 encoded string or None on failure.
    """
    try:
        buf = await page.screenshot(
            type="jpeg",
            quality=SCREENSHOT_JPEG_QUALITY,
            scale="css",
            full_page=full_page,
        )
        import base64

        return base64.b64encode(buf).decode("ascii")
    except Exception:
        return None


async def _build_saved_screenshot_result(
    page: Page,
    *,
    description: str | None = None,
    filename: str | None = None,
    full_page: bool = True,
) -> dict[str, Any]:
    """Build a screenshot result dict for saving."""
    import base64
    import re

    filename_base = (filename or "").strip() or f"browser-screenshot-{uuid.uuid4()}"
    normalized_base = re.sub(r"\.[^.]+$", "", filename_base)

    buf = await page.screenshot(
        type="jpeg",
        quality=SCREENSHOT_JPEG_QUALITY,
        scale="css",
        full_page=full_page,
    )

    return {
        "__saveScreenshot": True,
        "screenshot": base64.b64encode(buf).decode("ascii"),
        "description": (description or "").strip() or None,
        "filename": f"{normalized_base}.jpg",
        "__screenshotFullPage": full_page,
    }


async def _get_readable_content(page: Page) -> str:
    """Extract clean text from the page."""
    text: str = await page.evaluate("""
        (() => {
            const clone = document.body.cloneNode(true);
            const removeSelectors = 'script, style, nav, footer, header, aside, [role="navigation"], [role="banner"], [role="contentinfo"], noscript, svg';
            clone.querySelectorAll(removeSelectors).forEach(el => el.remove());
            return (clone.textContent || '').replace(/\\s+/g, ' ').trim();
        })()
    """)
    return text[:MAX_READABLE_CONTENT_BYTES]


async def _get_links(page: Page) -> list[dict[str, str]]:
    """Get top links from the page."""
    return await page.evaluate(f"""
        (() => {{
            const links = [];
            for (const a of document.querySelectorAll('a[href]')) {{
                const href = a.href;
                const text = (a.textContent || '').trim();
                if (href && text && !href.startsWith('javascript:')) {{
                    links.push({{ text: text.slice(0, {LINK_TEXT_MAX_LEN}), href }});
                }}
                if (links.length >= {MAX_LINKS}) break;
            }}
            return links;
        }})()
    """)


async def _get_interactive_elements(page: Page) -> list[dict[str, Any]]:
    """Discover all interactive elements with reliable selectors."""
    return await page.evaluate(f"""
        (() => {{
            const results = [];
            const seen = new Set();
            const selectors = 'button, input, select, textarea, a[href], [role="button"], [role="link"], [role="textbox"], [role="searchbox"], [role="combobox"], [role="tab"], [role="menuitem"]';

            for (const el of document.querySelectorAll(selectors)) {{
                if (results.length >= {MAX_INTERACTIVE_ELEMENTS}) break;
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 && rect.height === 0) continue;
                if (el.offsetParent === null && el.tagName !== 'BODY') continue;

                const tag = el.tagName.toLowerCase();
                const text = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, {ELEMENT_TEXT_MAX_LEN});
                const ariaLabel = el.getAttribute('aria-label') || '';
                const placeholder = el.getAttribute('placeholder') || '';
                const role = el.getAttribute('role') || '';
                const type = el.getAttribute('type') || '';
                const id = el.getAttribute('id') || '';
                const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || '';
                const name = el.getAttribute('name') || '';

                let selector = '';
                if (testId) {{
                    selector = '[data-testid="' + testId + '"]';
                }} else if (id && document.querySelectorAll('#' + CSS.escape(id)).length === 1) {{
                    selector = '#' + CSS.escape(id);
                }} else if (ariaLabel) {{
                    selector = tag + '[aria-label="' + ariaLabel.replace(/"/g, '\\\\"') + '"]';
                }} else if (name && tag === 'input') {{
                    selector = 'input[name="' + name.replace(/"/g, '\\\\"') + '"]';
                }} else if (placeholder) {{
                    selector = tag + '[placeholder="' + placeholder.replace(/"/g, '\\\\"') + '"]';
                }} else if (text && (tag === 'button' || tag === 'a')) {{
                    selector = 'text=' + text.slice(0, {SELECTOR_TEXT_MAX_LEN});
                }} else {{
                    const path = [];
                    let node = el;
                    while (node && node !== document.body) {{
                        const t = node.tagName.toLowerCase();
                        const siblings = node.parentElement ? Array.from(node.parentElement.children).filter(s => s.tagName === node.tagName) : [];
                        if (siblings.length > 1) {{
                            path.unshift(t + ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')');
                        }} else {{
                            path.unshift(t);
                        }}
                        node = node.parentElement;
                    }}
                    selector = path.join(' > ');
                }}

                const key = selector + '|' + tag;
                if (seen.has(key)) continue;
                seen.add(key);

                const entry = {{ tag, text: text || ariaLabel || placeholder, selector }};
                if (type) entry.type = type;
                if (placeholder) entry.placeholder = placeholder;
                if (role) entry.role = role;
                if (tag === 'input' || tag === 'textarea' || tag === 'select') {{
                    entry.value = (el.value || '').slice(0, 100);
                }}
                results.push(entry);
            }}
            return results;
        }})()
    """)


async def _get_visual_snapshot(
    page: Page,
    *,
    description: str | None = None,
    full_page: bool = False,
) -> dict[str, Any]:
    """Capture a visual snapshot for the LLM."""
    import base64

    title = await page.title()
    url = page.url
    buf = await page.screenshot(
        type="jpeg",
        quality=SCREENSHOT_JPEG_QUALITY,
        scale="css",
        full_page=full_page,
    )
    desc = (description or "").strip() or f'Visual snapshot of "{title}" ({url})'
    return {
        "screenshot": base64.b64encode(buf).decode("ascii"),
        "description": desc,
        "__screenshotFullPage": full_page,
    }


async def _get_page_snapshot(page: Page) -> str:
    """Quick page overview with interactive elements."""
    title = await page.title()
    url = page.url
    elements = await _get_interactive_elements(page)

    lines = [
        f"Page: {title}",
        f"URL: {url}",
        f"\nInteractive elements ({len(elements)}):",
    ]

    for i, el in enumerate(elements):
        desc = f'  [{i}] <{el["tag"]}>'
        if el.get("type"):
            desc += f' type="{el["type"]}"'
        if el.get("role"):
            desc += f' role="{el["role"]}"'
        if el.get("text"):
            desc += f' "{el["text"]}"'
        if el.get("placeholder"):
            desc += f' placeholder="{el["placeholder"]}"'
        desc += f' → selector: {el["selector"]}'
        lines.append(desc)

    return "\n".join(lines)


class BrowserService:
    """Manages browser sessions via BrowserGrid + Playwright."""

    def __init__(self) -> None:
        self._sessions: dict[str, BrowserSession] = {}
        self._playwright: Playwright | None = None

    async def _get_playwright(self) -> Playwright:
        """Lazily initialize the Playwright instance."""
        if self._playwright is None:
            pw = await async_playwright().start()
            self._playwright = pw
        return self._playwright

    async def health_check(self) -> bool:
        """Check if the BrowserGrid is healthy."""
        try:
            from clawbuddy.services.settings_service import settings_service

            url = await settings_service.get_browser_grid_url()
            async with httpx.AsyncClient(timeout=BROWSER_HEALTH_TIMEOUT_MS / 1000) as client:
                resp = await client.get(f"{url}/api/health")
                return resp.is_success
        except Exception:
            return False

    async def get_or_create_session(self, chat_session_id: str) -> BrowserSession:
        """Get or create a browser session for a chat session."""
        existing = self._sessions.get(chat_session_id)
        if existing:
            # Verify the connection is still alive
            try:
                await existing.page.evaluate("1")
                existing.last_activity_at = datetime.now(timezone.utc)
                return existing
            except Exception:
                logger.info(
                    f"[Browser] Stale session detected for {chat_session_id}, reconnecting..."
                )
                try:
                    if existing.close_fn:
                        await existing.close_fn()
                except Exception:
                    pass
                del self._sessions[chat_session_id]

        from clawbuddy.services.settings_service import settings_service

        grid_url = await settings_service.get_browser_grid_url()
        api_key = await settings_service.get_browser_grid_api_key()
        browser_type = await settings_service.get_browser_grid_browser()

        # Connect to BrowserGrid via CDP endpoint
        pw = await self._get_playwright()

        # Request a session from BrowserGrid
        headers: dict[str, str] = {}
        if api_key:
            headers["x-api-key"] = api_key

        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{grid_url}/api/sessions",
                json={
                    "browserType": browser_type,
                    "contextKey": f"clawbuddy-{chat_session_id}",
                },
                headers=headers,
            )
            resp.raise_for_status()
            session_data = resp.json()

        ws_url = (
            session_data.get("wsUrl")
            or session_data.get("cdpUrl")
            or session_data.get("ws_endpoint")
        )
        if not ws_url:
            raise RuntimeError("BrowserGrid did not return a WebSocket URL")

        # BrowserGrid exposes a Playwright websocket endpoint, not a CDP endpoint.
        if browser_type == "chromium":
            browser = await pw.chromium.connect(ws_url)
        else:
            browser = await pw.firefox.connect(ws_url)
        contexts = browser.contexts
        context = contexts[0] if contexts else await browser.new_context()
        pages = context.pages
        page = pages[0] if pages else await context.new_page()

        page.set_default_timeout(BROWSER_ACTION_TIMEOUT_MS)
        page.set_default_navigation_timeout(BROWSER_NAV_TIMEOUT_MS)

        session_id_grid = session_data.get("sessionId") or session_data.get("id", "")

        async def close_fn() -> None:
            try:
                await context.close()
            except Exception:
                pass
            try:
                await browser.close()
            except Exception:
                pass
            # Notify BrowserGrid to clean up
            if session_id_grid:
                try:
                    async with httpx.AsyncClient(timeout=5) as c:
                        await c.delete(
                            f"{grid_url}/api/sessions/{session_id_grid}",
                            headers=headers,
                        )
                except Exception:
                    pass

        session = BrowserSession(
            context=context,
            page=page,
            chat_session_id=chat_session_id,
            close_fn=close_fn,
        )
        self._sessions[chat_session_id] = session
        return session

    async def execute_script(
        self,
        chat_session_id: str,
        script: str,
        timeout: int = BROWSER_SCRIPT_DEFAULT_TIMEOUT_S,
    ) -> ScriptResult:
        """Execute a Playwright script from the agent."""
        import base64
        import re

        # Security: block dangerous URL schemes
        if re.search(r"\b(file|javascript)://", script, re.IGNORECASE):
            return ScriptResult(
                success=False,
                error="Scripts cannot use file:// or javascript:// URLs",
            )

        clamped_timeout = min(
            max(timeout, BROWSER_SCRIPT_MIN_TIMEOUT_S),
            BROWSER_SCRIPT_MAX_TIMEOUT_S,
        )

        try:
            session = await self.get_or_create_session(chat_session_id)
        except Exception as exc:
            return ScriptResult(
                success=False,
                error=f"Failed to create browser session: {exc}",
            )

        page = session.page

        # Build helper functions available to the script
        helpers = {
            "page": page,
            "getReadableContent": lambda: _get_readable_content(page),
            "getLinks": lambda: _get_links(page),
            "getInteractiveElements": lambda: _get_interactive_elements(page),
            "getPageSnapshot": lambda: _get_page_snapshot(page),
            "getVisualSnapshot": lambda **kwargs: _get_visual_snapshot(page, **kwargs),
            "saveScreenshot": lambda **kwargs: _build_saved_screenshot_result(page, **kwargs),
        }

        try:
            # Execute the script as an async function with helpers injected
            # We compile and execute the user script with the helpers in scope
            exec_globals: dict[str, Any] = {
                "__builtins__": __builtins__,
                "asyncio": asyncio,
                "page": page,
                "getReadableContent": helpers["getReadableContent"],
                "getLinks": helpers["getLinks"],
                "getInteractiveElements": helpers["getInteractiveElements"],
                "getPageSnapshot": helpers["getPageSnapshot"],
                "getVisualSnapshot": helpers["getVisualSnapshot"],
                "saveScreenshot": helpers["saveScreenshot"],
            }

            # Wrap the script in an async function
            wrapped = f"async def __browser_script__():\n"
            for line in script.split("\n"):
                wrapped += f"    {line}\n"

            exec(compile(wrapped, "<browser_script>", "exec"), exec_globals)
            fn = exec_globals["__browser_script__"]

            result = await asyncio.wait_for(fn(), timeout=clamped_timeout)

            # Format the result
            if result is None:
                output = "Script completed successfully (no return value)"
            elif isinstance(result, str):
                output = result
            else:
                # Handle screenshot results
                if isinstance(result, dict) and (
                    isinstance(result.get("screenshot"), (bytes, str))
                ):
                    full_pg = result.get("__screenshotFullPage", False)
                    resized = await capture_optimized_screenshot(page, full_page=full_pg)
                    if resized:
                        result["screenshot"] = resized
                    elif isinstance(result.get("screenshot"), bytes):
                        result["screenshot"] = base64.b64encode(
                            result["screenshot"]
                        ).decode("ascii")
                    result.pop("__screenshotFullPage", None)

                # Convert any remaining bytes fields
                if isinstance(result, dict):
                    for key in list(result.keys()):
                        if isinstance(result[key], bytes):
                            result[key] = base64.b64encode(result[key]).decode("ascii")

                output = json.dumps(result, indent=2, default=str)

            return ScriptResult(success=True, result=output)

        except asyncio.TimeoutError:
            return ScriptResult(
                success=False,
                error=f"Script timed out after {clamped_timeout}s",
            )
        except Exception as exc:
            error_message = str(exc)

            # If connection died, clean up stale session
            connection_errors = (
                "Connection ended",
                "Connection closed",
                "Target closed",
                "Browser has been closed",
            )
            if any(ce in error_message for ce in connection_errors):
                logger.info(
                    f"[Browser] Connection lost for {chat_session_id}, "
                    f"cleaning up stale session"
                )
                await self.close_session(chat_session_id)
                return ScriptResult(
                    success=False,
                    error=f"{error_message}. The browser session was lost — please retry.",
                )

            # Auto-screenshot on error for visual context
            screenshot_b64 = await capture_optimized_screenshot(page)

            return ScriptResult(
                success=False,
                error=error_message,
                screenshot_base64=screenshot_b64,
            )

    async def close_session(self, chat_session_id: str) -> None:
        """Close a specific browser session."""
        session = self._sessions.get(chat_session_id)
        if not session:
            return

        try:
            if session.close_fn:
                await session.close_fn()
        except Exception:
            pass
        self._sessions.pop(chat_session_id, None)

    async def cleanup_idle_sessions(self) -> None:
        """Clean up sessions idle for longer than BROWSER_IDLE_TIMEOUT_MS."""
        now = datetime.now(timezone.utc)
        to_close: list[str] = []
        for sid, session in self._sessions.items():
            elapsed_ms = (now - session.last_activity_at).total_seconds() * 1000
            if elapsed_ms > BROWSER_IDLE_TIMEOUT_MS:
                to_close.append(sid)

        for sid in to_close:
            logger.info(f"[Browser] Cleaning up idle session: {sid}")
            await self.close_session(sid)

    def get_active_sessions(self) -> list[dict[str, str]]:
        """Get active sessions info for the admin API."""
        return [
            {
                "chatSessionId": sid,
                "lastActivityAt": s.last_activity_at.isoformat(),
            }
            for sid, s in self._sessions.items()
        ]

    async def shutdown(self) -> None:
        """Shutdown all sessions (for graceful server shutdown)."""
        sids = list(self._sessions.keys())
        await asyncio.gather(
            *(self.close_session(sid) for sid in sids),
            return_exceptions=True,
        )
        if self._playwright:
            await self._playwright.stop()
            self._playwright = None


browser_service = BrowserService()
