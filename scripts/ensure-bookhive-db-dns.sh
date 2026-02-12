#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/.."

ENV_FILE="/opt/bookhive-env/bookhive-backend.env"
COMPOSE_FILE="docker-compose.bookhive-backend.yml"
[ -f "$COMPOSE_FILE" ] || COMPOSE_FILE="docker-compose.yml"

exists(){ docker inspect "$1" >/dev/null 2>&1; }

pick_db_container() {
  local c
  # Priority: use proxy if present, else direct postgres container
  for c in bookhive-pg-proxy bookhive-postgres docker-postgres; do
    if exists "$c"; then
      echo "$c"
      return 0
    fi
  done
  # Fallback: any running/existing postgres-like container by image/name
  c="$(docker ps -a --format '{{.Names}}\t{{.Image}}' | awk 'tolower($0) ~ /postgres|postgis|timescale/ {print $1; exit}')"
  [ -n "${c:-}" ] && { echo "$c"; return 0; }
  return 1
}

DB_CTN="$(pick_db_container || true)"
if [ -z "${DB_CTN}" ]; then
  echo "ERROR: no postgres/proxy container found."
  docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
  exit 1
fi

APIS=()
for a in bookhive-api-blue bookhive-api-green; do
  exists "$a" && APIS+=("$a")
done
if [ "${#APIS[@]}" -eq 0 ]; then
  echo "ERROR: no bookhive api containers found."
  docker ps -a --format 'table {{.Names}}\t{{.Status}}'
  exit 1
fi

# Collect all networks currently used by API containers
NETS="$(for a in "${APIS[@]}"; do
  docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{println $k}}{{end}}' "$a"
done | awk 'NF' | sort -u)"

# Ensure canonical shared network also exists
docker network inspect bookhive_backend >/dev/null 2>&1 || docker network create bookhive_backend
NETS="$(printf '%s\n%s\n' "$NETS" "bookhive_backend" | awk 'NF' | sort -u)"

echo "DB container selected: $DB_CTN"
echo "Target networks:"
printf ' - %s\n' $NETS

# Connect DB/proxy with alias "bookhive-postgres" on every API network
for n in $NETS; do
  docker network connect --alias bookhive-postgres "$n" "$DB_CTN" 2>/dev/null || true
  for a in "${APIS[@]}"; do
    docker network connect "$n" "$a" 2>/dev/null || true
  done
done

# Persist env overrides (non-destructive)
mkdir -p "$(dirname "$ENV_FILE")"
touch "$ENV_FILE"
sed -i '/^DB_HOST=/d;/^DB_PORT=/d' "$ENV_FILE"
printf '%s\n' 'DB_HOST=bookhive-postgres' 'DB_PORT=5432' >> "$ENV_FILE"

# If DATABASE_URL exists, force host to bookhive-postgres
sed -i -E 's#^(DATABASE_URL=postgres(ql)?://[^@]+@)[^:/]+(:[0-9]+/.*)$#\1bookhive-postgres\3#' "$ENV_FILE" || true

# Merge external env into project .env
if [ -x ./scripts/load-external-env-backend.sh ]; then
  ./scripts/load-external-env-backend.sh
fi

# Recreate ONLY API containers to pick updated env
docker compose -f "$COMPOSE_FILE" up -d --no-deps --force-recreate "${APIS[@]}"

# Verification
for a in "${APIS[@]}"; do
  echo
  echo "=== $a : env ==="
  docker exec "$a" sh -lc 'echo "DB_HOST=${DB_HOST:-<empty>}"; echo "DATABASE_URL=${DATABASE_URL:-<empty>}"'
  echo "=== $a : dns lookup ==="
  docker exec "$a" sh -lc 'node -e "require(\"dns\").lookup(\"bookhive-postgres\",(e,addr,f)=>{if(e){console.error(e.message);process.exit(1)};console.log(addr,f)})"'
  echo "=== $a : tcp 5432 ==="
  docker exec "$a" sh -lc 'node -e "const net=require(\"net\");const s=net.createConnection({host:\"bookhive-postgres\",port:5432});s.setTimeout(4000);s.on(\"connect\",()=>{console.log(\"tcp ok\");s.end()});s.on(\"timeout\",()=>{console.error(\"tcp timeout\");process.exit(1)});s.on(\"error\",e=>{console.error(e.message);process.exit(1)});"'
done

echo
echo "=== recent DNS-related logs ==="
docker logs --since=15m bookhive-api-blue  2>&1 | egrep -i 'EAI_AGAIN|getaddrinfo|bookhive-postgres' || true
docker logs --since=15m bookhive-api-green 2>&1 | egrep -i 'EAI_AGAIN|getaddrinfo|bookhive-postgres' || true

echo
echo "=== edge health ==="
curl --resolve api-bookhive.jrmsu-tc.cloud:443:127.0.0.1 -kIs https://api-bookhive.jrmsu-tc.cloud/health | sed -n '1,40p'
