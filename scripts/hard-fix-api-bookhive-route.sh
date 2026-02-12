#!/usr/bin/env bash
set -Eeuo pipefail

DOMAIN="api-bookhive.jrmsu-tc.cloud"
CADDY_CONTAINER="workloadhub_caddy"
CADDY_HOST_FILE="/opt/workloadhub-stack/Caddyfile"
ACTIVE_FILE="/opt/bookhive-env/bookhive-backend.active"

pick_color() {
  local req="${1:-auto}"
  if [ "$req" = "blue" ] || [ "$req" = "green" ]; then
    echo "$req"; return 0
  fi

  # choose newest healthy blue/green
  local best="" best_epoch=0
  for c in blue green; do
    local n="bookhive-api-$c"
    if docker inspect "$n" >/dev/null 2>&1; then
      local h s e
      h="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$n" 2>/dev/null || true)"
      if [ "$h" = "healthy" ]; then
        s="$(docker inspect --format '{{.State.StartedAt}}' "$n" 2>/dev/null || true)"
        e="$(date -d "$s" +%s 2>/dev/null || echo 0)"
        if [ "$e" -gt "$best_epoch" ]; then
          best="$c"; best_epoch="$e"
        fi
      fi
    fi
  done
  if [ -n "$best" ]; then
    echo "$best"; return 0
  fi

  # fallback: active marker
  if [ -f "$ACTIVE_FILE" ]; then
    local v
    v="$(tr -d ' \r\n' < "$ACTIVE_FILE" || true)"
    if [ "$v" = "blue" ] || [ "$v" = "green" ]; then
      echo "$v"; return 0
    fi
  fi

  # last fallback
  for c in blue green; do
    if docker inspect "bookhive-api-$c" >/dev/null 2>&1; then
      echo "$c"; return 0
    fi
  done

  echo "blue"
}

COLOR="$(pick_color "${1:-auto}")"
APP="bookhive-api-$COLOR"
UPSTREAM="${APP}:3000"

echo "Using color=$COLOR upstream=$UPSTREAM"

# Ensure target backend exists and is running/healthy
if ! docker inspect "$APP" >/dev/null 2>&1; then
  echo "ERROR: target container not found: $APP"
  exit 1
fi
STATE="$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$APP" 2>/dev/null || true)"
echo "Target state: $STATE"
if ! echo "$STATE" | grep -Eq 'running|healthy'; then
  echo "ERROR: $APP is not running/healthy"
  exit 1
fi

if [ ! -f "$CADDY_HOST_FILE" ]; then
  echo "ERROR: Caddy host file not found: $CADDY_HOST_FILE"
  exit 1
fi

# Backup host Caddyfile
cp -a "$CADDY_HOST_FILE" "${CADDY_HOST_FILE}.bak.$(date +%Y%m%d_%H%M%S)"

# Remove every existing api-bookhive block, append one clean block
tmp="$(mktemp)"
awk -v domain="$DOMAIN" -v up="$UPSTREAM" '
BEGIN {skip=0; depth=0}
{
  line=$0

  if (skip==0 && line ~ "^[[:space:]]*" domain "[[:space:]]*\\{[[:space:]]*$") {
    skip=1
    depth=1
    next
  }

  if (skip==1) {
    t=line
    opens=gsub(/\{/, "{", t)
    closes=gsub(/\}/, "}", t)
    depth += (opens - closes)
    if (depth<=0) skip=0
    next
  }

  print line
}
END {
  print ""
  print domain " {"
  print "    header X-Bookhive-Backend \"" up "\""
  print "    reverse_proxy " up
  print "    encode gzip zstd"
  print "}"
}
' "$CADDY_HOST_FILE" > "$tmp"

install -m 644 "$tmp" "$CADDY_HOST_FILE"
rm -f "$tmp"

# Remove stale api-bookhive fragments from conf.d to avoid duplicates
docker exec "$CADDY_CONTAINER" sh -lc \
  "mkdir -p /etc/caddy/conf.d; grep -R -l 'api-bookhive.jrmsu-tc.cloud' /etc/caddy/conf.d 2>/dev/null | xargs -r rm -f"

# Validate + reload Caddy from host-mounted file
docker exec "$CADDY_CONTAINER" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile

# Persist active color marker
printf '%s\n' "$COLOR" > "$ACTIVE_FILE"
chmod 600 "$ACTIVE_FILE" || true

echo
echo "--- Active block in host Caddyfile ---"
awk -v d="$DOMAIN" '
$0 ~ "^[[:space:]]*" d "[[:space:]]*\\{" {p=1}
p {print}
p && $0 ~ /^[[:space:]]*}[[:space:]]*$/ {exit}
' "$CADDY_HOST_FILE"

echo
echo "--- Verify live ---"
curl -Ik "https://${DOMAIN}/health" | sed -n '1,20p'
curl -sS "https://${DOMAIN}/health"; echo
curl -Ik "https://${DOMAIN}/" | sed -n '1,30p'
