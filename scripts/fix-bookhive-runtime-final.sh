#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_FILE="docker-compose.bookhive-backend.yml"
ENV_FILE=".env"
EXT_ENV="${BOOKHIVE_BACKEND_EXTERNAL_ENV:-/root/env-backups/bookhive-backend.env}"

echo "[1/9] Ensure .env exists + normalize line endings"
touch "$ENV_FILE"
sed -i 's/\r$//' "$ENV_FILE"

echo "[2/9] Ensure DATABASE_URL exists (recover from external env if needed)"
if ! grep -q '^DATABASE_URL=' "$ENV_FILE"; then
  if [ -f "$EXT_ENV" ]; then
    DB_FROM_EXT="$(grep -E '^DATABASE_URL=' "$EXT_ENV" | tail -n1 || true)"
    [ -n "$DB_FROM_EXT" ] && printf '\n%s\n' "$DB_FROM_EXT" >> "$ENV_FILE"
  fi
fi

if ! grep -q '^DATABASE_URL=' "$ENV_FILE"; then
  echo "ERROR: DATABASE_URL missing in $ENV_FILE"
  echo "Add it, then rerun:"
  echo "DATABASE_URL=postgresql://postgres:1234@bookhive-postgres:5432/bookhive"
  exit 1
fi

DBURL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | tail -n1 | cut -d= -f2-)"
if [ -z "$DBURL" ]; then
  echo "ERROR: DATABASE_URL is empty in $ENV_FILE"
  exit 1
fi

echo "[3/9] Normalize DB host for container networking (localhost -> host.docker.internal)"
DBURL_FIXED="$DBURL"
DBURL_FIXED="${DBURL_FIXED//@localhost:/@host.docker.internal:}"
DBURL_FIXED="${DBURL_FIXED//@127.0.0.1:/@host.docker.internal:}"

awk -v v="$DBURL_FIXED" '
BEGIN{done=0}
{
  if ($0 ~ /^DATABASE_URL=/) { print "DATABASE_URL=" v; done=1; next }
  print
}
END{
  if (!done) print "DATABASE_URL=" v
}
' "$ENV_FILE" > "${ENV_FILE}.tmp"
mv "${ENV_FILE}.tmp" "$ENV_FILE"

export DATABASE_URL="$DBURL_FIXED"

echo "[4/9] Make load-external-env script non-destructive"
cat > scripts/load-external-env-backend.sh <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_ENV="$ROOT_DIR/.env"

touch "$TARGET_ENV"
sed -i 's/\r$//' "$TARGET_ENV"

# Do not overwrite .env during deploy. Just validate required key.
if ! grep -q '^DATABASE_URL=' "$TARGET_ENV"; then
  echo "ERROR: DATABASE_URL missing in $TARGET_ENV"
  exit 1
fi
if grep -q '^DATABASE_URL=$' "$TARGET_ENV"; then
  echo "ERROR: DATABASE_URL is empty in $TARGET_ENV"
  exit 1
fi
SH
chmod +x scripts/load-external-env-backend.sh

echo "[5/9] Rewrite compose with explicit DATABASE_URL injection + host-gateway"
cat > "$COMPOSE_FILE" <<'YML'
name: bookhive-backend

services:
  bookhive-api-blue:
    container_name: bookhive-api-blue
    image: bookhive-api:bluegreen
    build:
      context: .
      dockerfile: Dockerfile
    env_file:
      - .env
    environment:
      NODE_ENV: production
      PORT: 3000
      DATABASE_URL: "${DATABASE_URL:?DATABASE_URL is required}"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    restart: unless-stopped
    init: true
    networks:
      - bookhive_backend_net
    volumes:
      - ./database.json:/app/database.json

  bookhive-api-green:
    container_name: bookhive-api-green
    image: bookhive-api:bluegreen
    build:
      context: .
      dockerfile: Dockerfile
    env_file:
      - .env
    environment:
      NODE_ENV: production
      PORT: 3000
      DATABASE_URL: "${DATABASE_URL:?DATABASE_URL is required}"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    restart: unless-stopped
    init: true
    networks:
      - bookhive_backend_net
    volumes:
      - ./database.json:/app/database.json

networks:
  bookhive_backend_net:
    name: bookhive_backend_net
    driver: bridge
YML

echo "[6/9] Validate compose + env injection"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" config >/dev/null
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" run --rm --no-deps --entrypoint sh bookhive-api-blue -lc 'test -n "${DATABASE_URL:-}" && echo DATABASE_URL_OK'

echo "[7/9] Build + clean only blue/green containers (safe)"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" build --no-cache
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" rm -sf bookhive-api-blue bookhive-api-green || true

echo "[8/9] Deploy"
if ! ./scripts/redeployment-bookhive-backend.sh deploy; then
  echo "Deploy failed; dumping diagnostics:"
  docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}' | grep -E 'bookhive-api-(blue|green)' || true
  docker logs --tail 200 bookhive-api-blue || true
  docker inspect --format '{{json .State}}' bookhive-api-blue || true
  exit 1
fi

echo "[9/9] Final status"
./scripts/redeployment-bookhive-backend.sh status
docker logs --tail 60 bookhive-api-blue || true

echo "DONE"
