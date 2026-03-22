"""Web Fetch capability.

Replaces: apps/api/src/capabilities/builtin/web-fetch.ts
"""

from __future__ import annotations

from typing import Any

WEB_FETCH: dict[str, Any] = {
    "slug": "web-fetch",
    "name": "Web Fetch",
    "description": (
        "Fetch and read web pages, APIs, and online resources. "
        "Converts HTML to readable Markdown automatically."
    ),
    "icon": "Globe",
    "category": "builtin",
    "version": "1.0.0",
    "tools": [
        {
            "name": "web_fetch",
            "description": (
                "Fetch a URL and return its content. HTML pages are automatically "
                "converted to Markdown for readability. Use this to read documentation, "
                "API responses, web pages, or any online resource when you already have "
                "a specific URL."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "The URL to fetch (http or https)",
                    },
                    "format": {
                        "type": "string",
                        "description": (
                            'Output format: "markdown" (default — converts HTML to '
                            'Markdown), "text" (strips all tags), "html" (raw HTML)'
                        ),
                    },
                    "method": {
                        "type": "string",
                        "description": "HTTP method (default: GET)",
                    },
                    "headers": {
                        "type": "object",
                        "description": "Custom request headers as key-value pairs",
                    },
                    "body": {
                        "type": "string",
                        "description": "Request body for POST/PUT/PATCH requests",
                    },
                    "maxKb": {
                        "type": "number",
                        "description": "Max response size in KB (default: 100, max: 5000)",
                    },
                },
                "required": ["url"],
            },
        },
    ],
    "systemPrompt": (
        "You have access to web_fetch for downloading and reading web content directly.\n\n"
        "**When to use each web tool:**\n"
        "- **web_fetch**: When you have a specific URL to read (documentation, API "
        "endpoints, GitHub files, articles)\n"
        "- **web_search**: When you need to FIND information with a search query\n"
        "- **run_browser_script**: Only when you need to INTERACT with a page "
        "(login, fill forms, click buttons)\n\n"
        "web_fetch returns the full page content converted to Markdown by default. "
        "For JSON APIs, the raw JSON is returned as-is."
    ),
    "sandbox": {},
}
