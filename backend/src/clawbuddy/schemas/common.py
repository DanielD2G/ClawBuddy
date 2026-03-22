"""Common response schemas used across all endpoints.

Replaces: packages/shared/src/types/index.ts (ApiResponse) + pagination helpers.
"""

from __future__ import annotations

from typing import Any, Generic, TypeVar

from pydantic import BaseModel, Field

T = TypeVar("T")


class ApiResponse(BaseModel, Generic[T]):
    """Standard API response wrapper."""

    success: bool
    data: T | None = None
    error: str | None = None


class PaginatedMeta(BaseModel):
    """Pagination metadata."""

    page: int
    limit: int
    total: int
    total_pages: int = Field(alias="totalPages")

    model_config = {"populate_by_name": True}


class PaginatedResponse(BaseModel, Generic[T]):
    """Paginated API response."""

    success: bool = True
    data: list[T] = Field(default_factory=list)
    meta: PaginatedMeta


class IdResponse(BaseModel):
    """Response containing just an ID."""

    id: str


class MessageResponse(BaseModel):
    """Response containing just a message."""

    message: str


class CountResponse(BaseModel):
    """Response containing a count."""

    count: int


def paginated_meta(*, page: int, limit: int, total: int) -> PaginatedMeta:
    """Build pagination metadata from query results."""
    total_pages = max(1, (total + limit - 1) // limit)
    return PaginatedMeta(page=page, limit=limit, total=total, totalPages=total_pages)
