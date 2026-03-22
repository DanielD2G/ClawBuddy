"""Async Redis connection.

Replaces: apps/api/src/lib/redis.ts
"""

from __future__ import annotations

from redis.asyncio import Redis

from clawbuddy.settings import settings

redis_client: Redis = Redis(
    host=settings.redis_host,
    port=settings.redis_port,
    db=settings.redis_db,
    decode_responses=True,
)

# Connection config dict for ARQ and other Redis consumers
redis_connection_config: dict[str, str | int] = {
    "host": settings.redis_host,
    "port": settings.redis_port,
}
