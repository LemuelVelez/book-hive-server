#!/usr/bin/env bash
set -Eeuo pipefail

DOMAIN="api-bookhive.jrmsu-tc.cloud"
EDGE="${1:-workloadhub_caddy}"
ACTIVE_FILE="/opt/bookhive-env/bookhive-backend.active"

exists() { docker inspect "$1" >/dev/null 2>&1; }
state_of() {
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1" 2>/dev/null || true
}

pick_color() {
  # 1) newest healthy first (prefer freshly deployed)
  local best="" best_epoch=0
  for c in blue green; do
    local n="bookhive-api-$c"
    if exists "$n"; then
      local s started epoch
      s="$(state_of "$n")"
      if [ "$s" = "healthy" ]; then
        started="$(docker inspect --format '{{.State.StartedAt}}' "$n" 2>/dev/null || true)"
        epoch="$(date -d "$started" +%s 2>/dev/null || echo 0)"
        if [ "$epoch" -gt "$best_epoch" ]; then
          best="$c"; best_epoch="$epoch"
        fi
      fi
    fi
  done
  if [ -n "$best" ]; then
    echo "$best"; return 0
  fi

  # 2) active marker if running/healthy
  if [ -f "$ACTIVE_FILE" ]; then
    local c n s
    c="$(tr -d ' \r\n' < "$ACTIVE_FILE" || true)"
    if [ "$c" = "blue" ] || [ "$c" = "green" ]; then
      n="bookhive-api-$c"
      if exists "$n"; then
        s="$(state_of "$n")"
        if [ "$s" = "healthy" ] || [ "$s" = "running" ]; then
          echo "$c"; return 0
        fi
      fi
    fi
  fi

  # 3) fallback any running
  for c in blue green; do
    local n="bookhive-api-$c"
    if exists "$n"; then
      local s
      s="$(state_of "$n")"
      if [ "$s" = "running" ] || [ "$s" = "healthy" ]; then
        echo "$c"; return 0
      fi
    fi
  done

  echo "blue"
}

COLOR="$(pick_color)"
UPSTREAM="bookhive-api-${COLOR}:3000"
TARGET="bookhive-api-${COLOR}"
TS="$(date +%Y%m%d_%H%M%S)"

echo "Using color=$COLOR upstream=$UPSTREAM"
echo "Target state: $(state_of "$TARGET")"

if ! exists "$EDGE"; then
  echo "ERROR: edge container '$EDGE' not found"
  exit 1
fi

HOST_CADDY="$(docker inspect "$EDGE" --format '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}')"
if [ -z "${HOST_CADDY:-}" ] || [ ! -f "$HOST_CADDY" ]; then
  echo "ERROR: could not resolve host-mounted Caddyfile for $EDGE"
  exit 1
fi

echo "Host Caddyfile: $HOST_CADDY"
cp -a "$HOST_CADDY" "${HOST_CADDY}.bak.${TS}"

# Remove any existing api-bookhive blocks (with or without scheme) from host Caddyfile.
CLEANED="$(mktemp)"
awk -v dom="$DOMAIN" '
function lcnt(s, t){ t=s; return gsub(/\{/,"{",t) }
function rcnt(s, t){ t=s; return gsub(/\}/,"}",t) }
BEGIN{ skip=0; depth=0 }
{
  if (skip) {
    depth += lcnt($0) - rcnt($0)
    if (depth <= 0) { skip=0; depth=0 }
    next
  }

  # Matches:
  # api-bookhive.jrmsu-tc.cloud {
  # https://api-bookhive.jrmsu-tc.cloud {
  # api-bookhive.jrmsu-tc.cloud:443 {
  if ($0 ~ "^[[:space:]]*(https://)?" dom "(:[0-9]+)?[[:space:]]*\\{[[:space:]]*$") {
    skip=1
    depth = lcnt($0) - rcnt($0)
    if (depth <= 0) { skip=0; depth=0 }
    next
  }

  print
}
' "$HOST_CADDY" > "$CLEANED"

TMP="$(mktemp)"
{
  cat <<BLOCK
${DOMAIN} {
    @probe path /__edge_probe
    respond @probe 200 "api-bookhive -> ${UPSTREAM}"

    reverse_proxy ${UPSTREAM} {
        header_down +X-Bookhive-Backend "${UPSTREAM}"
    }
    encode gzip zstd
}

BLOCK
  cat "$CLEANED"
} > "$TMP"

mv "$TMP" "$HOST_CADDY"
rm -f "$CLEANED"

# Remove stale snippet files inside container that still mention this domain.
docker exec "$EDGE" sh -lc "grep -Rls '${DOMAIN}' /etc/caddy/conf.d 2>/dev/null | xargs -r rm -f || true"

# Validate + reload
docker exec "$EDGE" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker exec "$EDGE" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile

# Persist active color marker
printf '%s\n' "$COLOR" > "$ACTIVE_FILE"
chmod 600 "$ACTIVE_FILE"

echo
echo "--- Probe (must return api-bookhive -> ${UPSTREAM}) ---"
curl --resolve "${DOMAIN}:443:127.0.0.1" -ksS "https://${DOMAIN}/__edge_probe"; echo

echo
echo "--- /health headers (should include X-Bookhive-Backend) ---"
curl --resolve "${DOMAIN}:443:127.0.0.1" -kIs "https://${DOMAIN}/health" | sed -n '1,40p'
