#!/usr/bin/env bash
set -Eeuo pipefail

REQ_COLOR="${1:-auto}"        # auto|blue|green
EDGE="${2:-workloadhub_caddy}"
DOMAIN="api-bookhive.jrmsu-tc.cloud"
ACTIVE_FILE="/opt/bookhive-env/bookhive-backend.active"

exists() { docker inspect "$1" >/dev/null 2>&1; }
state_of() {
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1" 2>/dev/null || true
}

pick_color() {
  if [ "$REQ_COLOR" = "blue" ] || [ "$REQ_COLOR" = "green" ]; then
    echo "$REQ_COLOR"; return 0
  fi

  # newest healthy first
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

  # fallback active marker
  if [ -f "$ACTIVE_FILE" ]; then
    local v
    v="$(tr -d ' \r\n' < "$ACTIVE_FILE" || true)"
    if [ "$v" = "blue" ] || [ "$v" = "green" ]; then
      echo "$v"; return 0
    fi
  fi

  echo "blue"
}

COLOR="$(pick_color)"
UPSTREAM="bookhive-api-${COLOR}:3000"
TARGET="bookhive-api-${COLOR}"

if ! exists "$TARGET"; then
  echo "ERROR: $TARGET not found"; exit 1
fi
TS="$(state_of "$TARGET")"
if [ "$TS" != "healthy" ] && [ "$TS" != "running" ]; then
  echo "ERROR: $TARGET state is '$TS'"; exit 1
fi

CADDY_HOST_FILE="$(docker inspect "$EDGE" --format '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}')"
if [ -z "${CADDY_HOST_FILE:-}" ] || [ ! -f "$CADDY_HOST_FILE" ]; then
  echo "ERROR: Cannot find host-mounted Caddyfile for $EDGE"; exit 1
fi

echo "Using color=$COLOR upstream=$UPSTREAM"
echo "Host Caddyfile: $CADDY_HOST_FILE"

# If container sees different file content, restart container once to refresh bind mount reference
HOST_SUM="$(sha256sum "$CADDY_HOST_FILE" | awk '{print $1}')"
CONT_SUM="$(docker exec "$EDGE" sha256sum /etc/caddy/Caddyfile | awk '{print $1}' || true)"
if [ -n "$CONT_SUM" ] && [ "$HOST_SUM" != "$CONT_SUM" ]; then
  echo "Detected host/container Caddyfile mismatch. Restarting $EDGE to refresh bind mount..."
  docker restart "$EDGE" >/dev/null
fi

cp -a "$CADDY_HOST_FILE" "${CADDY_HOST_FILE}.bak.$(date +%Y%m%d_%H%M%S)"

tmp_body="$(mktemp)"
tmp_new="$(mktemp)"

# Remove all existing api-bookhive site blocks (brace-aware)
awk -v domain="$DOMAIN" '
function trim(s){sub(/^[ \t]+/,"",s); sub(/[ \t]+$/,"",s); return s}
function cnt(s,ch, i,n){n=0; for(i=1;i<=length(s);i++) if(substr(s,i,1)==ch) n++; return n}
BEGIN{skip=0; depth=0}
{
  line=$0
  t=trim(line)

  # match: api-bookhive.jrmsu-tc.cloud {  OR api-bookhive.jrmsu-tc.cloud:443 {
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

# IMPORTANT: in-place overwrite (no mv) to preserve inode for file bind mount
cat "$tmp_new" > "$CADDY_HOST_FILE"

rm -f "$tmp_body" "$tmp_new"

# Remove stale imported route files that may override
docker exec "$EDGE" sh -lc 'rm -f /etc/caddy/conf.d/bookhive-api.caddy /etc/caddy/conf.d/*bookhive*api*.caddy 2>/dev/null || true'

docker exec "$EDGE" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker exec "$EDGE" caddy reload   --config /etc/caddy/Caddyfile --adapter caddyfile

printf '%s\n' "$COLOR" > "$ACTIVE_FILE"
chmod 600 "$ACTIVE_FILE" || true

echo
echo "--- Probe must be plain text ---"
curl --resolve "${DOMAIN}:443:127.0.0.1" -ksS "https://${DOMAIN}/__edge_probe"; echo

echo
echo "--- Health headers (must include X-Bookhive-Backend) ---"
curl --resolve "${DOMAIN}:443:127.0.0.1" -kIs "https://${DOMAIN}/health" | sed -n '1,60p'

echo
echo "--- Adapted route for api-bookhive ---"
docker exec "$EDGE" caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile 2>/dev/null \
  | tr ',' '\n' | grep -E 'api-bookhive\.jrmsu-tc\.cloud|bookhive-api-(blue|green):3000|__edge_probe' || true
