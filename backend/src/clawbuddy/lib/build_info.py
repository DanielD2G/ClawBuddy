"""Build information utilities.

Replaces: apps/api/src/lib/build-info.ts
"""

from __future__ import annotations

from typing import TypedDict

from clawbuddy.settings import settings


class BuildInfo(TypedDict):
    version: str
    commit_sha: str
    built_at: str | None


def get_build_info() -> BuildInfo:
    """Return build metadata from environment variables."""
    return {
        "version": settings.CLAWBUDDY_VERSION or "dev",
        "commit_sha": settings.CLAWBUDDY_COMMIT_SHA or "local",
        "built_at": settings.CLAWBUDDY_BUILD_TIME or None,
    }
