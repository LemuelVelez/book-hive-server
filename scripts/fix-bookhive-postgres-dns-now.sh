#!/usr/bin/env bash
set -Eeuo pipefail

NET="${1:-bookhive_backend}"

exists(){ docker inspect "$1" >/dev/null 2>&1; }

# 1) Ensure shared network exists
docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET"

# 2) Connect DB + both blue/green APIs to same network
if exists bookhive-postgres; then
  docker network connect --alias bookhive-postgres "$NET" bookhive-postgres 2>/dev/null || true
fi
if exists bookhive-api-blue; then
  docker network connect "$NET" bookhive-api-blue 2>/dev/null || true
fi
if exists bookhive-api-green; then
  docker network connect "$NET" bookhive-api-green 2>/dev/null || true
fi

# 3) Restart API containers only (no DB restart)
docker restart bookhive-api-blue 2>/dev/null || true
docker restart bookhive-api-green 2>/dev/null || true

# 4) Verify DNS from API containers
for c in bookhive-api-blue bookhive-api-green; do
  if docker ps --format '{{.Names}}' | grep -qx "$c"; then
    echo "== $c =="
    docker exec "$c" getent hosts bookhive-postgres || true
    docker exec "$c" sh -lc 'echo DB_HOST=$DB_HOST; echo DATABASE_URL=${DATABASE_URL:-<empty>}' || true
  fi
done

echo "Done. If getent returns an IP, EAI_AGAIN should stop."
