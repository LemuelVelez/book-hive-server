#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_FILE="docker-compose.bookhive-backend.yml"
ENV_FILE=".env"

echo "[1/8] Ensure env file exists..."
touch "$ENV_FILE"

echo "[2/8] Patch external env loader to MERGE (not clobber) .env..."
cat > scripts/load-external-env-backend.sh <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_ENV="$ROOT_DIR/.env"
EXT_ENV="${BOOKHIVE_BACKEND_EXTERNAL_ENV:-/root/env-backups/bookhive-backend.env}"

touch "$TARGET_ENV"

# If external file doesn't exist, keep current .env as-is.
[ -f "$EXT_ENV" ] || exit 0

tmp="$(mktemp)"
cp "$TARGET_ENV" "$tmp"

# Merge key=value lines from external env into current .env
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    ''|\#*) continue ;;
    *=*)
      key="${line%%=*}"
      grep -v "^${key}=" "$tmp" > "${tmp}.new" || true
      printf '%s\n' "$line" >> "${tmp}.new"
      mv "${tmp}.new" "$tmp"
      ;;
  esac
done < "$EXT_ENV"

mv "$tmp" "$TARGET_ENV"

# Fail fast if DATABASE_URL missing/empty
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

echo "[3/8] Ensure compose file has env_file + host-gateway for backend..."
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

echo "[4/8] Try to auto-recover DATABASE_URL if missing..."
if ! grep -q '^DATABASE_URL=' "$ENV_FILE"; then
  FOUND_DB="$(grep -Rhs '^DATABASE_URL=' /root/env-backups /root/book-hive /root/book-hive-server 2>/dev/null | tail -n1 || true)"
  if [ -n "${FOUND_DB:-}" ]; then
    printf '\n%s\n' "$FOUND_DB" >> "$ENV_FILE"
    echo "Recovered DATABASE_URL from existing env sources."
  fi
fi

echo "[5/8] Validate DATABASE_URL exists..."
if ! grep -q '^DATABASE_URL=' "$ENV_FILE"; then
  echo "ERROR: DATABASE_URL is still missing in $ENV_FILE"
  echo "Add it now (example format):"
  echo "DATABASE_URL=postgres://bookhive_user:bookhive_pass@host.docker.internal:5432/bookhive_db"
  exit 1
fi
if grep -q '^DATABASE_URL=$' "$ENV_FILE"; then
  echo "ERROR: DATABASE_URL is empty in $ENV_FILE"
  exit 1
fi

echo "[6/8] Validate compose and injected env..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" config >/dev/null
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" run --rm --no-deps --entrypoint sh bookhive-api-blue -lc 'test -n "${DATABASE_URL:-}" && echo DATABASE_URL_OK'

echo "[7/8] Rebuild image and remove only old blue/green containers..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" build --no-cache
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" rm -sf bookhive-api-blue bookhive-api-green || true

echo "[8/8] Deploy + status..."
./scripts/redeployment-bookhive-backend.sh deploy
./scripts/redeployment-bookhive-backend.sh status

echo "Done."
