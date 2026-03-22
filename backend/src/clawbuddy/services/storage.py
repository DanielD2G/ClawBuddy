"""S3/MinIO storage service.

Replaces: apps/api/src/services/storage.service.ts
"""

from __future__ import annotations

from typing import Any

from botocore.exceptions import ClientError
from loguru import logger

from clawbuddy.lib.s3 import get_bucket, get_s3_client


class StorageService:
    """Object storage operations backed by S3/MinIO."""

    async def ensure_bucket_exists(self) -> None:
        """Create the bucket if it doesn't already exist."""
        async with get_s3_client() as s3:
            try:
                await s3.create_bucket(Bucket=get_bucket())
            except ClientError as e:
                code = e.response.get("Error", {}).get("Code", "")
                if code not in (
                    "BucketAlreadyOwnedByYou",
                    "BucketAlreadyExists",
                ):
                    # Also check HTTP 409
                    status = e.response.get("ResponseMetadata", {}).get(
                        "HTTPStatusCode"
                    )
                    if status != 409:
                        raise

    async def upload(self, key: str, body: bytes, content_type: str) -> dict[str, str]:
        """Upload an object and return its key."""
        async with get_s3_client() as s3:
            await s3.put_object(
                Bucket=get_bucket(),
                Key=key,
                Body=body,
                ContentType=content_type,
            )
        return {"key": key}

    async def download(self, key: str) -> bytes | None:
        """Download an object's bytes. Returns None if not found."""
        async with get_s3_client() as s3:
            try:
                response = await s3.get_object(Bucket=get_bucket(), Key=key)
                return await response["Body"].read()
            except ClientError as e:
                if e.response["Error"]["Code"] == "NoSuchKey":
                    return None
                raise

    async def list_objects(self, prefix: str) -> list[dict[str, Any]]:
        """List objects under a prefix."""
        async with get_s3_client() as s3:
            response = await s3.list_objects_v2(Bucket=get_bucket(), Prefix=prefix)
            return response.get("Contents", [])

    async def delete_object(self, key: str) -> None:
        """Delete a single object."""
        async with get_s3_client() as s3:
            await s3.delete_object(Bucket=get_bucket(), Key=key)


storage_service = StorageService()
