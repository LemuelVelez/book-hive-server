#!/usr/bin/env bash
set -Eeuo pipefail

REQ_COLOR="${1:-auto}"                  # auto | blue | green
EDGE="${2:-workloadhub_caddy}"
DOMAIN="api-bookhive.jrmsu-tc.cloud"
ACTIVE_FILE="/opt/bookhive-env/bookhive-backend.active"

exists() { docker inspect "$1" >/dev/null 2>&1; }
state_of() {
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1" 2>/dev/null || true
}

wait_running() {
  local n="$1" i s
  for i in $(seq 1 40); do
    s="$(docker inspect --format '{{.State.Status}}' "$n" 2>/dev/null || true)"
    if [ "$s" = "running" ]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

pick_color() {
  if [ "$REQ_COLOR" = "blue" ] || [ "$REQ_COLOR" = "green" ]; then
    echo "$REQ_COLOR"; return 0
  fi

  # Prefer newest healthy
  local best="" best_epoch=0
  for c in blue green; do
    local n="bookhive-api-$c"
    if exists "$n"; then
      local st started epoch
      st="$(state_of "$n")"
      if [ "$st" = "healthy" ]; then
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

  # Fallback to active marker
  if [ -f "$ACTIVE_FILE" ]; then
    local v
    v="$(tr -d ' \r\n' < "$ACTIVE_FILE" || true)"
    if [ "$v" = "blue" ] || [ "$v" = "green" ]; then
      echo "$v"; return 0
    fi
  fi

  # Final fallback
  echo "blue"
}

COLOR="$(pick_color)"
UPSTREAM="bookhive-api-${COLOR}:3000"
TARGET="bookhive-api-${COLOR}"

if ! exists "$TARGET"; then
  echo "ERROR: target container not found: $TARGET"
  exit 1
fi

TSTATE="$(state_of "$TARGET")"
if [ "$TSTATE" != "healthy" ] && [ "$TSTATE" != "running" ]; then
  echo "ERROR: target container not ready: $TARGET state=$TSTATE"
  exit 1
fi

CADDY_HOST_FILE="$(docker inspect "$EDGE" --format '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}')"
if [ -z "${CADDY_HOST_FILE:-}" ] || [ ! -f "$CADDY_HOST_FILE" ]; then
  echo "ERROR: Cannot find host-mounted /etc/caddy/Caddyfile for $EDGE"
  exit 1
fi

echo "Using color=$COLOR upstream=$UPSTREAM"
echo "Target state: $TSTATE"
echo "Host Caddyfile: $CADDY_HOST_FILE"

cp -a "$CADDY_HOST_FILE" "${CADDY_HOST_FILE}.bak.$(date +%Y%m%d_%H%M%S)"

tmp_body="$(mktemp)"
tmp_new="$(mktemp)"

# Remove ALL existing api-bookhive site blocks in a brace-safe way
awk -v domain="$DOMAIN" '
function trim(s){sub(/^[ \t]+/,"",s); sub(/[ \t]+$/,"",s); return s}
function cnt(s,ch, i,n){n=0; for(i=1;i<=length(s);i++) if(substr(s,i,1)==ch) n++; return n}
BEGIN{skip=0; depth=0}
{
  line=$0
  t=trim(line)

  if(!skip && (t==domain" {" || t==domain":443 {" || t==domain":80 {")) {
    skip=1
    depth=1
    next
  }

  if(skip){
    depth += cnt(line,"{") - cnt(line,"}")
    if(depth<=0){skip=0}
    next
  }

  print line
}
' "$CADDY_HOST_FILE" > "$tmp_body"

cat > "$tmp_new" <<BLOCK
${DOMAIN} {
    @probe path /__edge_probe
    respond @probe 200 "api-bookhive -> ${UPSTREAM}"

    reverse_proxy ${UPSTREAM} {
        header_down +X-Bookhive-Backend "${UPSTREAM}"
    }

    encode gzip zstd
}

BLOCK

cat "$tmp_body" >> "$tmp_new"

# In-place overwrite (preserve inode for bind mount)
cat "$tmp_new" > "$CADDY_HOST_FILE"
rm -f "$tmp_body" "$tmp_new"

# Remove stale conf.d overrides
docker exec "$EDGE" sh -lc 'rm -f /etc/caddy/conf.d/bookhive-api.caddy /etc/caddy/conf.d/*bookhive*api*.caddy 2>/dev/null || true'

# Restart edge once so container sees latest bind-mounted file content for sure
docker restart "$EDGE" >/dev/null
if ! wait_running "$EDGE"; then
  echo "ERROR: $EDGE did not return to running state"
  docker logs --tail 120 "$EDGE" || true
  exit 1
fi

# Validate + reload
docker exec "$EDGE" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker exec "$EDGE" caddy reload   --config /etc/caddy/Caddyfile --adapter caddyfile

printf '%s\n' "$COLOR" > "$ACTIVE_FILE"
chmod 600 "$ACTIVE_FILE" || true

echo
echo "--- Probe (must be plain text) ---"
curl --resolve "${DOMAIN}:443:127.0.0.1" --max-time 10 -kSsf "https://${DOMAIN}/__edge_probe"; echo

echo
echo "--- /health headers (must include X-Bookhive-Backend) ---"
curl --resolve "${DOMAIN}:443:127.0.0.1" --max-time 10 -kIsS "https://${DOMAIN}/health" | sed -n '1,80p'

echo
echo "--- Adapted config lines ---"
docker exec "$EDGE" caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile 2>/dev/null \
  | tr ',' '\n' \
  | grep -E 'api-bookhive\.jrmsu-tc\.cloud|bookhive-api-(blue|green):3000|__edge_probe' || true
