"""Pagination utilities.

Replaces: apps/api/src/lib/pagination.ts
"""

from __future__ import annotations

from clawbuddy.constants import DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT


def parse_pagination(
    page: int | None = None,
    limit: int | None = None,
) -> dict[str, int]:
    """Parse and clamp pagination parameters.

    Args:
        page: 1-based page number (defaults to 1).
        limit: Items per page (defaults to DEFAULT_PAGE_LIMIT, capped at MAX_PAGE_LIMIT).

    Returns:
        Dict with keys ``page``, ``limit``, and ``skip``.
    """
    safe_page = max(1, page if page is not None else 1)
    safe_limit = min(MAX_PAGE_LIMIT, max(1, limit if limit is not None else DEFAULT_PAGE_LIMIT))
    skip = (safe_page - 1) * safe_limit
    return {"page": safe_page, "limit": safe_limit, "skip": skip}
