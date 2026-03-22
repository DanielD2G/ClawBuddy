"""Browser Automation capability.

Replaces: apps/api/src/capabilities/builtin/browser-automation.ts
"""

from __future__ import annotations

from typing import Any

BROWSER_AUTOMATION: dict[str, Any] = {
    "slug": "browser-automation",
    "name": "Browser Automation",
    "description": "Browse and interact with web pages using Playwright scripts via BrowserGrid.",
    "icon": "Globe",
    "category": "builtin",
    "version": "1.0.0",
    "tools": [
        {
            "name": "run_browser_script",
            "description": (
                "Execute ONE small action in the browser per call. The session persists "
                "between calls — do not repeat previous steps.\n\n"
                "Available globals:\n"
                "- `page` — Playwright Page object (already connected, keeps state between calls)\n"
                "- `getInteractiveElements()` — Returns visible buttons, inputs, links with "
                "reliable selectors [{tag, text, selector, type?, placeholder?, role?, value?}]\n"
                "- `getPageSnapshot()` — Quick page overview: title, URL, and all interactive elements\n"
                "- `getReadableContent()` — Extract clean text from current page (max 50KB)\n"
                "- `getLinks()` — Get top 30 links as [{text, href}]\n"
                "- `getVisualSnapshot(options?)` — Capture a visual JPEG screenshot for you to "
                "see the page. Does NOT save to disk. Use this when you need to visually inspect "
                "the page. Returns `{ screenshot, description }`. Options: "
                "`{ description?: string, fullPage?: boolean }`\n"
                "- `saveScreenshot(options?)` — Save a JPEG screenshot to disk. ONLY use when "
                "the user explicitly asks to save, download, or export a screenshot file. "
                "Returns `{ savedPath, description? }`\n\n"
                "RULES:\n"
                "1. ONE action per call. Navigate OR discover OR fill OR click — never combine them.\n"
                "2. NEVER guess selectors. Call getPageSnapshot() or getInteractiveElements() "
                "first to discover them.\n"
                "3. ALWAYS return an observation (getPageSnapshot, getReadableContent, or "
                "getLinks) so you can see what happened.\n"
                "4. After page.goto(), ONLY return getPageSnapshot() — do NOT try to interact "
                "in the same call.\n"
                "5. After filling/clicking, return getPageSnapshot() or getReadableContent() "
                "to verify the result.\n"
                "6. To visually see what a page looks like, use `getVisualSnapshot()` — it lets "
                "you see the page as an image without saving to disk.\n"
                "7. Do NOT call saveScreenshot() unless the user explicitly asked to "
                "save/download/export an image file to disk.\n\n"
                "Example — searching on a site takes 3+ separate calls:\n"
                "  Call 1: await page.goto(url); return await getPageSnapshot();\n"
                "  Call 2: const els = await getInteractiveElements(); const input = els.find(...); "
                "await page.fill(input.selector, 'query'); return await getPageSnapshot();\n"
                "  Call 3: const els = await getInteractiveElements(); const btn = els.find(...); "
                "await page.click(btn.selector); return await getPageSnapshot();\n"
                "  Call 4: return await getReadableContent();"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "script": {
                        "type": "string",
                        "description": (
                            "Playwright script with access to page object. "
                            "Use await for async ops. Return results."
                        ),
                    },
                    "timeout": {
                        "type": "number",
                        "description": "Max execution time in seconds (default: 30, max: 120)",
                    },
                },
                "required": ["script"],
            },
        },
    ],
    "systemPrompt": """You have browser automation via run_browser_script. You MUST work step-by-step: one action per call, observe, then decide the next action.

## When to use (and when NOT to)
- **DO NOT use for searching/finding information** — use web_search instead, it's faster and cheaper.
- **DO use for**: interacting with specific websites (fill forms, click buttons, log in, scrape dynamic content, take screenshots, navigate multi-page flows).

## CRITICAL: Step-by-step workflow
Each run_browser_script call must do exactly ONE of these:
1. **Navigate**: `await page.goto(url); return await getPageSnapshot();`
2. **Discover**: `return await getPageSnapshot();` or `return await getInteractiveElements();`
3. **Interact**: Find element + fill/click ONE thing, then `return await getPageSnapshot();`
4. **Read**: `return await getReadableContent();` or `return await getLinks();`
5. **Visual inspect**: `return await getVisualSnapshot({ description: 'what I expect to see' });` — lets you see the page as an image without saving to disk. Use this when you need to visually describe a page.
6. **Save screenshot (only when user explicitly asks)**: `return await saveScreenshot({ description: '...', filename: 'name', fullPage: true });` — writes to disk. Only use when the user asks to save/download/export an image file.

NEVER combine navigate + interact in one call. NEVER guess selectors — discover first, interact in the next call.

## Why step-by-step?
- Pages load dynamically — you can't know what elements exist until you look
- Selectors change between pages — you must discover them fresh each time
- If something fails, you'll know exactly which step broke

## Session persistence
The browser session persists between calls. Cookies, login state, current URL, and page content all carry over. Do NOT re-navigate or re-login if you're already on the right page.

## Example: searching on a website
```
Call 1: await page.goto('https://example.com'); return await getPageSnapshot();
→ You see the page with a search input at selector '#search-box'

Call 2: await page.fill('#search-box', 'my query'); await page.keyboard.press('Enter'); return await getPageSnapshot();
→ You see search results loaded

Call 3: return await getReadableContent();
→ You read the actual content
```

## Rules
- Always use the `selector` field from getInteractiveElements/getPageSnapshot results
- After any navigation or click that loads new content, call getPageSnapshot() to see the new state
- Use page.waitForTimeout(1000-2000) after clicks that trigger page loads before reading
- To visually inspect a page, use `getVisualSnapshot()` — it sends you the image without saving to disk
- Only use `saveScreenshot()` when the user explicitly requests saving/downloading/exporting a screenshot file to disk""",
    "sandbox": {},
}
