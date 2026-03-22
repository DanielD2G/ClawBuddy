"""Permission service — checks if tool calls are allowed by workspace allowlist.

Replaces: apps/api/src/services/permission.service.ts
"""

from __future__ import annotations

import re
from typing import Any

from clawbuddy.constants import ALWAYS_ALLOWED_TOOLS


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _parse_rule(rule: str) -> tuple[str, str]:
    """Parse a permission rule like ``Bash(aws s3 ls *)`` into (type, pattern).

    Returns (type, pattern). If no parens, the entire string is the type with
    a wildcard ``*`` pattern.
    """
    m = re.match(r"^(\w+)\((.+)\)$", rule)
    if m:
        return m.group(1), m.group(2)
    return rule, "*"


def _normalize_tool_call(
    tool_name: str, arguments: dict[str, Any]
) -> tuple[str, str]:
    """Map a tool call to a (type, value) pair for permission checking."""
    match tool_name:
        case "run_bash":
            return "Bash", str(arguments.get("command", ""))
        case "aws_command":
            return "Bash", f"aws {arguments.get('command', '')}"
        case "kubectl_command":
            return "Bash", f"kubectl {arguments.get('command', '')}"
        case "docker_command":
            return "Bash", f"docker {arguments.get('command', '')}"
        case "run_python":
            return "Python", str(arguments.get("code", ""))
        case "read_file" | "list_files":
            return "Read", str(arguments.get("path", "/workspace"))
        case "write_file":
            return "Write", f"path:{arguments.get('path', '')}"
        case "search_documents":
            return "SearchDocuments", ""
        case "save_document":
            return "SaveDocument", str(arguments.get("title", ""))
        case "generate_file":
            return "GenerateFile", str(arguments.get("filename", ""))
        case _:
            return tool_name, ""


def _glob_match(pattern: str, value: str) -> bool:
    """Simple glob match — ``*`` matches any substring."""
    escaped = re.escape(pattern).replace(r"\*", ".*")
    return bool(re.fullmatch(escaped, value))


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

class PermissionService:
    """Determines whether a tool call is pre-approved by the workspace allowlist."""

    def is_tool_allowed(
        self,
        tool_name: str,
        arguments: dict[str, Any],
        allow_rules: list[str],
    ) -> bool:
        """Return ``True`` if the tool call is allowed (no approval needed).

        *allow_rules* is the workspace's permission allowlist (e.g.
        ``["Bash(git *)", "Read(*)", "Python(*)"]``).
        """
        # Non-destructive tools are always allowed
        if tool_name in ALWAYS_ALLOWED_TOOLS:
            return True

        norm_type, norm_value = _normalize_tool_call(tool_name, arguments)

        for rule in allow_rules:
            parsed_type, parsed_pattern = _parse_rule(rule)
            if parsed_type != norm_type:
                continue
            if _glob_match(parsed_pattern, norm_value):
                return True

        return False


permission_service = PermissionService()
