"""Built-in capabilities registry.

Replaces: apps/api/src/capabilities/builtin/index.ts
"""

from __future__ import annotations

from typing import Any

from clawbuddy.capabilities.builtin.agent_memory import AGENT_MEMORY
from clawbuddy.capabilities.builtin.browser_automation import BROWSER_AUTOMATION
from clawbuddy.capabilities.builtin.cron_management import CRON_MANAGEMENT
from clawbuddy.capabilities.builtin.document_search import DOCUMENT_SEARCH
from clawbuddy.capabilities.builtin.google_workspace import GOOGLE_WORKSPACE
from clawbuddy.capabilities.builtin.read_file import READ_FILE
from clawbuddy.capabilities.builtin.sub_agent_delegation import SUB_AGENT_DELEGATION
from clawbuddy.capabilities.builtin.tool_discovery import TOOL_DISCOVERY
from clawbuddy.capabilities.builtin.web_fetch import WEB_FETCH
from clawbuddy.capabilities.builtin.web_search import WEB_SEARCH

# Only capabilities with custom (non-sandbox) execution logic remain as builtins.
# bash, python, aws-cli, kubectl, docker have been migrated to .skill files.
BUILTIN_CAPABILITIES: list[dict[str, Any]] = [
    DOCUMENT_SEARCH,
    AGENT_MEMORY,
    CRON_MANAGEMENT,
    WEB_SEARCH,
    WEB_FETCH,
    READ_FILE,
    GOOGLE_WORKSPACE,
    BROWSER_AUTOMATION,
    TOOL_DISCOVERY,
    SUB_AGENT_DELEGATION,
]

BUILTIN_CAPABILITIES_MAP: dict[str, dict[str, Any]] = {
    cap["slug"]: cap for cap in BUILTIN_CAPABILITIES
}
