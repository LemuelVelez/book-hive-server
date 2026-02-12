#!/usr/bin/env bash
set -Eeuo pipefail

DOMAIN="api-bookhive.jrmsu-tc.cloud"
CADDY_CONTAINER="workloadhub_caddy"
ACTIVE_FILE="/opt/bookhive-env/bookhive-backend.active"

exists() {
  docker inspect "$1" >/dev/null 2>&1
}

health_of() {
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1" 2>/dev/null || true
}

pick_color() {
  local preferred="blue"
  if [ -f "$ACTIVE_FILE" ]; then
    local v
    v="$(tr -d ' \r\n' < "$ACTIVE_FILE" || true)"
    [ "$v" = "green" ] && preferred="green"
  fi

  # Prefer currently active if healthy
  for c in "$preferred" blue green; do
    [ "$c" = "blue" ] || [ "$c" = "green" ] || continue
    local n="bookhive-api-$c"
    if exists "$n" && [ "$(health_of "$n")" = "healthy" ]; then
      echo "$c"
      return 0
    fi
  done

  # Fallback: any existing container
  for c in blue green; do
    local n="bookhive-api-$c"
    if exists "$n"; then
      echo "$c"
      return 0
    fi
  done

  echo "none"
}

COLOR="$(pick_color)"
if [ "$COLOR" = "none" ]; then
  echo "ERROR: no bookhive-api-blue/green container found."
  exit 1
fi

UPSTREAM="bookhive-api-${COLOR}:3000"
echo "Selected color: $COLOR"
echo "Upstream: $UPSTREAM"

echo "[1/6] Ensure selected backend is healthy (or at least running)..."
STATE="$(health_of "bookhive-api-${COLOR}")"
echo "Container state: $STATE"
if [ "$STATE" != "healthy" ] && [ "$STATE" != "running" ]; then
  echo "ERROR: bookhive-api-${COLOR} is not healthy/running."
  exit 1
fi

echo "[2/6] Write dedicated conf.d route..."
TMP_ROUTE="$(mktemp)"
cat > "$TMP_ROUTE" <<ROUTE
$DOMAIN {
    reverse_proxy $UPSTREAM
    encode gzip zstd
}
ROUTE

docker exec "$CADDY_CONTAINER" mkdir -p /etc/caddy/conf.d
docker cp "$TMP_ROUTE" "$CADDY_CONTAINER:/etc/caddy/conf.d/bookhive-api.caddy"
rm -f "$TMP_ROUTE"

echo "[3/6] Remove legacy api-bookhive block from main Caddyfile (safe write, no sed -i)..."
docker exec -e DOMAIN="$DOMAIN" "$CADDY_CONTAINER" sh -lc '
set -e
awk -v d="$DOMAIN" '"'"'
BEGIN { skip=0; depth=0 }
{
  line=$0
  if (skip==0 && line ~ "^[[:space:]]*" d "[[:space:]]*\\{[[:space:]]*$") {
    skip=1
    depth=1
    next
  }
  if (skip==1) {
    opens = gsub(/\{/, "{", line)
    closes = gsub(/\}/, "}", line)
    depth += opens - closes
    if (depth <= 0) skip=0
    next
  }
  print line
}
'"'"' /etc/caddy/Caddyfile > /tmp/Caddyfile.cleaned

cat /tmp/Caddyfile.cleaned > /etc/caddy/Caddyfile

grep -qE "^[[:space:]]*import /etc/caddy/conf\.d/\*\.caddy" /etc/caddy/Caddyfile || \
  printf "\nimport /etc/caddy/conf.d/*.caddy\n" >> /etc/caddy/Caddyfile
'

echo "[4/6] Validate and reload Caddy..."
docker exec "$CADDY_CONTAINER" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile

echo "[5/6] Persist active color marker..."
printf '%s\n' "$COLOR" > "$ACTIVE_FILE"
chmod 600 "$ACTIVE_FILE" || true

echo "[6/6] Show effective route snippets..."
docker exec "$CADDY_CONTAINER" sh -lc 'echo "--- conf.d/bookhive-api.caddy ---"; cat /etc/caddy/conf.d/bookhive-api.caddy'
docker exec "$CADDY_CONTAINER" sh -lc 'echo "--- Caddyfile api-bookhive matches (should be empty) ---"; grep -n "^api-bookhive.jrmsu-tc.cloud[[:space:]]*{" /etc/caddy/Caddyfile || true'

echo "Done."
