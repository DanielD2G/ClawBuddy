#!/bin/sh
set -eu

cd /app
if ! bun install --frozen-lockfile; then
  echo "bun install reported non-fatal errors; continuing with the Compose command" >&2
fi

exec "$@"
