#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/.."

ENV_FILE="/opt/bookhive-env/bookhive-backend.env"
COMPOSE_FILE="docker-compose.bookhive-backend.yml"
[ -f "$COMPOSE_FILE" ] || COMPOSE_FILE="docker-compose.yml"

exists(){ docker inspect "$1" >/dev/null 2>&1; }

APIS=()
for a in bookhive-api-blue bookhive-api-green; do
  exists "$a" && APIS+=("$a")
done
[ "${#APIS[@]}" -gt 0 ] || { echo "ERROR: no bookhive API containers found."; exit 1; }

PROBE="${APIS[0]}"
mapfile -t NETS < <(
  for a in "${APIS[@]}"; do
    docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{println $k}}{{end}}' "$a"
  done | awk 'NF' | sort -u
)

for n in "${NETS[@]}"; do
  docker network connect "$n" docker-postgres 2>/dev/null || true
  docker network connect "$n" bookhive-pg-proxy 2>/dev/null || true
  docker network connect "$n" bookhive-postgres 2>/dev/null || true
done

can_tcp() {
  local host="$1" port="$2"
  docker exec "$PROBE" node -e "
    const net=require('net');
    const s=net.createConnection({host:'$host',port:$port});
    s.setTimeout(3000);
    s.on('connect',()=>{s.end();});
    s.on('timeout',()=>process.exit(1));
    s.on('error',()=>process.exit(1));
  " >/dev/null 2>&1
}

TARGET_HOST=""
TARGET_PORT=""
for ep in "docker-postgres:5432" "bookhive-postgres:5432" "bookhive-pg-proxy:6432" "bookhive-pg-proxy:5432"; do
  H="${ep%:*}"; P="${ep#*:}"
  if can_tcp "$H" "$P"; then TARGET_HOST="$H"; TARGET_PORT="$P"; break; fi
done
[ -n "$TARGET_HOST" ] || { echo "ERROR: no reachable DB endpoint"; exit 1; }

mkdir -p "$(dirname "$ENV_FILE")"
touch "$ENV_FILE"

# Preserve credentials/db path but force host/port and sslmode=disable
CUR_URL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | tail -1 | cut -d= -f2- | sed -E 's#\?.*$##')"
[ -n "$CUR_URL" ] || CUR_URL="postgresql://postgres:1234@${TARGET_HOST}:${TARGET_PORT}/bookhive"
CUR_URL="$(echo "$CUR_URL" | sed -E "s#^(postgres(ql)?://[^@]+@)[^/:]+(:[0-9]+)?(/.*)$#\1${TARGET_HOST}:${TARGET_PORT}\4#")"
NEW_URL="${CUR_URL}?sslmode=disable"

sed -i '/^DB_HOST=/d;/^DB_PORT=/d;/^DATABASE_URL=/d;/^PGSSLMODE=/d;/^DB_SSL=/d;/^PGSSL=/d;/^DB_REQUIRE_SSL=/d' "$ENV_FILE"
{
  echo "DB_HOST=${TARGET_HOST}"
  echo "DB_PORT=${TARGET_PORT}"
  echo "PGSSLMODE=disable"
  echo "DB_SSL=false"
  echo "DATABASE_URL=${NEW_URL}"
} >> "$ENV_FILE"

[ -x ./scripts/load-external-env-backend.sh ] && ./scripts/load-external-env-backend.sh || true
docker compose -f "$COMPOSE_FILE" up -d --no-deps --force-recreate "${APIS[@]}"

for a in "${APIS[@]}"; do
  echo "=== $a ==="
  docker exec "$a" sh -lc 'echo "$DATABASE_URL"; echo "DB_HOST=$DB_HOST DB_PORT=$DB_PORT PGSSLMODE=$PGSSLMODE DB_SSL=$DB_SSL"'
done
