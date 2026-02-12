#!/usr/bin/env bash
set -Eeuo pipefail

DOMAIN="api-bookhive.jrmsu-tc.cloud"
CADDY_CONTAINER="workloadhub_caddy"
ACTIVE_FILE="/opt/bookhive-env/bookhive-backend.active"

exists() { docker inspect "$1" >/dev/null 2>&1; }

health() {
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1" 2>/dev/null || true
}

pick_color_auto() {
  # pick newest healthy backend (blue/green)
  local best="" best_epoch=0
  for c in blue green; do
    local n="bookhive-api-$c"
    if exists "$n" && [ "$(health "$n")" = "healthy" ]; then
      local started epoch
      started="$(docker inspect --format '{{.State.StartedAt}}' "$n")"
      epoch="$(date -d "$started" +%s 2>/dev/null || echo 0)"
      if [ "$epoch" -gt "$best_epoch" ]; then
        best="$c"; best_epoch="$epoch"
      fi
    fi
  done
  if [ -n "$best" ]; then
    echo "$best"; return 0
  fi

  # fallback to active marker
  if [ -f "$ACTIVE_FILE" ]; then
    local v
    v="$(tr -d ' \r\n' < "$ACTIVE_FILE" || true)"
    if [ "$v" = "blue" ] || [ "$v" = "green" ]; then
      echo "$v"; return 0
    fi
  fi

  # fallback to existing container
  for c in blue green; do
    if exists "bookhive-api-$c"; then echo "$c"; return 0; fi
  done

  echo "blue"
}

COLOR="${1:-auto}"
if [ "$COLOR" = "auto" ]; then
  COLOR="$(pick_color_auto)"
fi

BACKEND="bookhive-api-${COLOR}"
UPSTREAM="${BACKEND}:3000"

if ! exists "$BACKEND"; then
  echo "ERROR: $BACKEND does not exist."
  exit 1
fi

STATE="$(health "$BACKEND")"
if [ "$STATE" != "healthy" ] && [ "$STATE" != "running" ]; then
  echo "ERROR: $BACKEND is not healthy/running (state=$STATE)."
  exit 1
fi

echo "Using color=$COLOR upstream=$UPSTREAM"

# Find host source path for /etc/caddy/Caddyfile mount
CADDYFILE_SRC="$(docker inspect "$CADDY_CONTAINER" --format '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}')"
if [ -z "${CADDYFILE_SRC:-}" ]; then
  echo "ERROR: Could not resolve host source for /etc/caddy/Caddyfile mount."
  echo "Run: docker inspect $CADDY_CONTAINER --format '{{json .Mounts}}'"
  exit 1
fi

if [ ! -f "$CADDYFILE_SRC" ]; then
  echo "ERROR: Host Caddyfile source not found: $CADDYFILE_SRC"
  exit 1
fi

echo "Host Caddyfile source: $CADDYFILE_SRC"

# Backup
BACKUP="${CADDYFILE_SRC}.bak.$(date +%Y%m%d_%H%M%S)"
cp -a "$CADDYFILE_SRC" "$BACKUP"
echo "Backup: $BACKUP"

# Rewrite: remove old api-bookhive block from main Caddyfile, then append correct one
TMP="$(mktemp)"
awk -v d="$DOMAIN" -v up="$UPSTREAM" '
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
END {
  print ""
  print d " {"
  print "    reverse_proxy " up
  print "    encode gzip zstd"
  print "}"
}
' "$CADDYFILE_SRC" > "$TMP"

install -m 644 "$TMP" "$CADDYFILE_SRC"
rm -f "$TMP"

# Remove conf.d duplicate for same domain (avoid duplicate host blocks)
docker exec "$CADDY_CONTAINER" sh -lc 'rm -f /etc/caddy/conf.d/bookhive-api.caddy || true'

# Validate + reload using main Caddyfile
docker exec "$CADDY_CONTAINER" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile

# Persist active color marker
printf '%s\n' "$COLOR" > "$ACTIVE_FILE"
chmod 600 "$ACTIVE_FILE" || true

echo "Route switched to $UPSTREAM"

echo "--- Verify host block in Caddyfile ---"
grep -n "^${DOMAIN}[[:space:]]*{" "$CADDYFILE_SRC" || true

echo "--- Health check ---"
curl -skI "https://${DOMAIN}/health" | sed -n '1,15p'
echo "--- Root sample (first 200 bytes) ---"
curl -sk "https://${DOMAIN}/" | head -c 200; echo
