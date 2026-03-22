"""File serving routes.

Replaces: apps/api/src/routes/files.ts
"""

from __future__ import annotations

import posixpath

from fastapi import APIRouter, Request
from fastapi.responses import Response

from clawbuddy.lib.responses import fail
from clawbuddy.lib.sanitize import sanitize_file_name
from clawbuddy.services.storage import storage_service

router = APIRouter(tags=["Files"])

_ALLOWED_PREFIXES = ("generated/", "uploads/")


@router.get("/files/{file_path:path}")
async def get_file(file_path: str, request: Request) -> Response:
    """Serve a file from object storage."""
    key = file_path
    normalized = posixpath.normpath(key)

    if (
        not key
        or "\0" in key
        or normalized.startswith("..")
        or normalized != key
    ):
        return fail("Invalid file path", status_code=400)  # type: ignore[return-value]

    if not any(key.startswith(p) for p in _ALLOWED_PREFIXES):
        return fail("Invalid file path", status_code=400)  # type: ignore[return-value]

    body = await storage_service.download(key)
    if body is None:
        return fail("File not found", status_code=404)  # type: ignore[return-value]

    filename = sanitize_file_name(key.rsplit("/", 1)[-1] if "/" in key else "file")
    return Response(
        content=body,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
