#!/usr/bin/env bash
set -Eeuo pipefail

DOMAIN="api-bookhive.jrmsu-tc.cloud"
CADDY_CONTAINER="workloadhub_caddy"
ACTIVE_FILE="/opt/bookhive-env/bookhive-backend.active"

exists() { docker inspect "$1" >/dev/null 2>&1; }
health() {
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1" 2>/dev/null || true
}

pick_color() {
  local req="${1:-auto}"
  if [ "$req" = "blue" ] || [ "$req" = "green" ]; then
    echo "$req"; return 0
  fi

  # 1) active marker if healthy/running
  if [ -f "$ACTIVE_FILE" ]; then
    local c n h
    c="$(tr -d ' \r\n' < "$ACTIVE_FILE" || true)"
    if [ "$c" = "blue" ] || [ "$c" = "green" ]; then
      n="bookhive-api-$c"
      if exists "$n"; then
        h="$(health "$n")"
        if [ "$h" = "healthy" ] || [ "$h" = "running" ]; then
          echo "$c"; return 0
        fi
      fi
    fi
  fi

  # 2) newest healthy
  local best="" best_epoch=0
  for c in blue green; do
    local n="bookhive-api-$c"
    if exists "$n"; then
      local h s e
      h="$(health "$n")"
      if [ "$h" = "healthy" ]; then
        s="$(docker inspect --format '{{.State.StartedAt}}' "$n" 2>/dev/null || true)"
        e="$(date -d "$s" +%s 2>/dev/null || echo 0)"
        if [ "$e" -gt "$best_epoch" ]; then
          best="$c"; best_epoch="$e"
        fi
      fi
    fi
  done
  if [ -n "$best" ]; then echo "$best"; return 0; fi

  # 3) any existing
  for c in blue green; do
    local n="bookhive-api-$c"
    if exists "$n"; then echo "$c"; return 0; fi
  done

  echo "ERROR: no bookhive-api-{blue,green} container found" >&2
  exit 1
}

COLOR="$(pick_color "${1:-auto}")"
UPSTREAM="bookhive-api-${COLOR}:3000"
TARGET="bookhive-api-${COLOR}"

echo "Using color=${COLOR}, upstream=${UPSTREAM}"

if ! exists "$TARGET"; then
  echo "ERROR: target container ${TARGET} not found" >&2
  exit 1
fi

STATE="$(health "$TARGET")"
echo "Target state: ${STATE}"
if [ "$STATE" != "healthy" ] && [ "$STATE" != "running" ]; then
  echo "ERROR: target container ${TARGET} is not healthy/running" >&2
  exit 1
fi

# Find host-mounted Caddyfile path from container mount
CADDY_HOST_FILE="$(docker inspect "$CADDY_CONTAINER" --format '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}')"
if [ -z "${CADDY_HOST_FILE:-}" ] || [ ! -f "$CADDY_HOST_FILE" ]; then
  echo "ERROR: could not resolve host Caddyfile mount path" >&2
  exit 1
fi
echo "Host Caddyfile: $CADDY_HOST_FILE"

cp -a "$CADDY_HOST_FILE" "${CADDY_HOST_FILE}.bak.$(date +%Y%m%d_%H%M%S)"

# Remove ALL existing api-bookhive site blocks safely (nested-brace aware)
python3 - "$CADDY_HOST_FILE" "$DOMAIN" <<'PY'
import re, sys
path, domain = sys.argv[1], sys.argv[2]
with open(path, 'r', encoding='utf-8') as f:
    lines = f.readlines()

out = []
i = 0
pat = re.compile(r'^\s*' + re.escape(domain) + r'\s*\{\s*$')

while i < len(lines):
    if pat.match(lines[i]):
        depth = 0
        while i < len(lines):
            depth += lines[i].count('{')
            depth -= lines[i].count('}')
            i += 1
            if depth <= 0:
                break
        continue
    out.append(lines[i])
    i += 1

with open(path, 'w', encoding='utf-8') as f:
    f.writelines(out)
PY

# Prepend canonical api-bookhive block with probe + response marker header
tmp="$(mktemp)"
cat > "$tmp" <<CADDY
${DOMAIN} {
    @probe path /__route_probe
    respond @probe 200 "api-bookhive -> ${UPSTREAM}"

    reverse_proxy ${UPSTREAM} {
        header_down +X-Bookhive-Backend "${UPSTREAM}"
    }
    encode gzip zstd
}

CADDY

cat "$tmp" "$CADDY_HOST_FILE" > "${CADDY_HOST_FILE}.new"
mv "${CADDY_HOST_FILE}.new" "$CADDY_HOST_FILE"
rm -f "$tmp"

# Remove stale conf.d route (if your old script keeps writing it)
docker exec "$CADDY_CONTAINER" sh -lc 'rm -f /etc/caddy/conf.d/bookhive-api.caddy || true'

# Validate + reload Caddy using mounted config
docker exec "$CADDY_CONTAINER" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile

echo
echo "--- Effective api-bookhive block ---"
awk -v d="$DOMAIN" '
  $0 ~ "^"d"[[:space:]]*\\{"{p=1}
  p{print}
  p && /^}/{exit}
' "$CADDY_HOST_FILE"

echo
echo "--- Verify LOCAL edge path (bypass DNS surprises) ---"
curl -ksS --resolve ${DOMAIN}:443:127.0.0.1 https://${DOMAIN}/__route_probe; echo
curl -ksSI --resolve ${DOMAIN}:443:127.0.0.1 https://${DOMAIN}/health | sed -n '1,30p'
