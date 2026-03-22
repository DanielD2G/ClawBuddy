"""URL safety checks — prevent SSRF by detecting private/internal hosts.

Replaces: apps/api/src/lib/url-safety.ts
"""

from __future__ import annotations

import re

_PRIVATE_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"^localhost$", re.IGNORECASE),
    re.compile(r"^127\."),
    re.compile(r"^10\."),
    re.compile(r"^172\.(1[6-9]|2\d|3[01])\."),
    re.compile(r"^192\.168\."),
    re.compile(r"^169\.254\."),
    re.compile(r"^0\."),
    re.compile(r"^\[::1\]$"),
    re.compile(r"^\[fd", re.IGNORECASE),
    re.compile(r"^\[fe80:", re.IGNORECASE),
]


def is_private_host(hostname: str) -> bool:
    """Return True if *hostname* resolves to a private/internal address."""
    return any(p.search(hostname) for p in _PRIVATE_PATTERNS)
