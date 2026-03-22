"""Global error handler for FastAPI.

Replaces: apps/api/src/middleware/error-handler.ts
"""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import ORJSONResponse
from loguru import logger

from clawbuddy.lib.errors import AppError


def register_error_handlers(app: FastAPI) -> None:
    """Register all exception handlers on the FastAPI app."""

    @app.exception_handler(AppError)
    async def app_error_handler(_request: Request, exc: AppError) -> ORJSONResponse:
        logger.error(f"[AppError] {exc.message}")
        return ORJSONResponse(
            status_code=exc.status_code,
            content={
                "success": False,
                "error": exc.message,
                "code": exc.code,
            },
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(
        _request: Request, exc: RequestValidationError
    ) -> ORJSONResponse:
        errors = exc.errors()
        detail = "; ".join(
            f"{'.'.join(str(loc) for loc in e['loc'])}: {e['msg']}" for e in errors
        )
        logger.warning(f"[ValidationError] {detail}")
        return ORJSONResponse(
            status_code=400,
            content={
                "success": False,
                "error": detail,
                "code": "VALIDATION_ERROR",
            },
        )

    @app.exception_handler(Exception)
    async def generic_error_handler(_request: Request, exc: Exception) -> ORJSONResponse:
        logger.exception(f"[UnhandledError] {exc}")
        status_code = getattr(exc, "status", 500)
        if not isinstance(status_code, int):
            status_code = 500
        message = "Internal Server Error" if status_code == 500 else str(exc)
        return ORJSONResponse(
            status_code=status_code,
            content={"success": False, "error": message},
        )
