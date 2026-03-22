"""Custom error classes for the application.

Replaces: apps/api/src/lib/errors.ts
"""

from __future__ import annotations


class AppError(Exception):
    """Base application error with HTTP status code and error code."""

    def __init__(
        self,
        message: str,
        status_code: int = 500,
        code: str | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.code = code


class ValidationError(AppError):
    """Validation error (400)."""

    def __init__(self, message: str) -> None:
        super().__init__(message, status_code=400, code="VALIDATION_ERROR")


class NotFoundError(AppError):
    """Resource not found error (404)."""

    def __init__(self, entity: str, entity_id: str | None = None) -> None:
        msg = f"{entity} not found: {entity_id}" if entity_id else f"{entity} not found"
        super().__init__(msg, status_code=404, code="NOT_FOUND")


class ConfigurationError(AppError):
    """Configuration error (500)."""

    def __init__(self, message: str) -> None:
        super().__init__(message, status_code=500, code="CONFIGURATION_ERROR")
