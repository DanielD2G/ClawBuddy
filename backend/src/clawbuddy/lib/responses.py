"""Standardized JSON response helpers.

Replaces: apps/api/src/lib/responses.ts
"""

from __future__ import annotations

from typing import Any, Literal, TypeVar

from fastapi.responses import JSONResponse

T = TypeVar("T")


def ok(data: Any, status_code: Literal[200, 201] = 200) -> JSONResponse:
    """Return a success JSON response."""
    return JSONResponse(
        content={"success": True, "data": data},
        status_code=status_code,
    )


def fail(
    error: str,
    status_code: Literal[400, 401, 403, 404, 409, 500] = 400,
) -> JSONResponse:
    """Return an error JSON response."""
    return JSONResponse(
        content={"success": False, "error": error},
        status_code=status_code,
    )
