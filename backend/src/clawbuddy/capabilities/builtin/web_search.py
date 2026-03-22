"""Web Search (Gemini) capability.

Replaces: apps/api/src/capabilities/builtin/web-search.ts
"""

from __future__ import annotations

from typing import Any

WEB_SEARCH: dict[str, Any] = {
    "slug": "web-search",
    "name": "Web Search (Gemini)",
    "description": (
        "Search the web for current information using Google Search via Gemini. "
        "Requires a Gemini API key."
    ),
    "icon": "Search",
    "category": "builtin",
    "version": "1.0.0",
    "tools": [
        {
            "name": "web_search",
            "description": (
                "Search the web for current, real-time information. Use this when "
                "the user asks about recent events, live data, current prices, news, "
                "or anything that requires up-to-date information not in your training data."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The search query to look up on the web",
                    },
                },
                "required": ["query"],
            },
        },
    ],
    "systemPrompt": (
        "You have access to web_search for real-time web information. Use it when "
        "the user asks about current events, live data, recent news, prices, weather, "
        "or anything that needs up-to-date information. Do NOT use it for general "
        "knowledge questions you can already answer.\n\n"
        "**IMPORTANT: web_search is ALWAYS preferred over browser automation for "
        "finding information.** Only use browser automation (run_browser_script) "
        "when you need to interact with a specific website (fill forms, click buttons, "
        "log in, navigate pages). For any search or information lookup query, ALWAYS "
        "use web_search first."
    ),
    "sandbox": {},
}
