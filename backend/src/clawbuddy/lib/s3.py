"""S3 client for MinIO object storage.

Replaces: apps/api/src/lib/s3.ts
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from collections.abc import AsyncGenerator
from typing import Any

import aioboto3

from clawbuddy.settings import settings

_session = aioboto3.Session()


@asynccontextmanager
async def get_s3_client() -> AsyncGenerator[Any, None]:
    """Get an async S3 client configured for MinIO.

    Usage:
        async with get_s3_client() as s3:
            await s3.put_object(Bucket=..., Key=..., Body=...)
    """
    async with _session.client(
        "s3",
        endpoint_url=settings.MINIO_ENDPOINT,
        aws_access_key_id=settings.MINIO_ACCESS_KEY,
        aws_secret_access_key=settings.MINIO_SECRET_KEY,
        region_name="us-east-1",
    ) as client:
        yield client


def get_bucket() -> str:
    """Return the configured MinIO bucket name."""
    return settings.MINIO_BUCKET
