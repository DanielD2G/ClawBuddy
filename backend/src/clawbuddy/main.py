"""Application entry point.

Replaces: apps/api/src/index.ts

Run with: uvicorn clawbuddy.main:app --host 0.0.0.0 --port 4000 --reload
"""

from __future__ import annotations

import sys

from loguru import logger

# Configure loguru - remove default handler, add custom one
logger.remove()
logger.add(
    sys.stderr,
    format="<green>{time:HH:mm:ss}</green> | <level>{level: <8}</level> | <cyan>{name}</cyan>:<cyan>{line}</cyan> - <level>{message}</level>",
    level="INFO",
    colorize=True,
)

from clawbuddy.app import create_app  # noqa: E402

app = create_app()

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "clawbuddy.main:app",
        host="0.0.0.0",
        port=4000,
        reload=True,
        timeout_keep_alive=255,  # Prevents killing SSE streams during long LLM calls
    )
