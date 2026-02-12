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

pick_color() {
  if [ "$REQ_COLOR" = "blue" ] || [ "$REQ_COLOR" = "green" ]; then
    echo "$REQ_COLOR"; return 0
  fi

  # Prefer newest healthy blue/green
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

  # Fallback to active marker
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
  echo "ERROR: target container $TARGET does not exist"
  exit 1
fi

TARGET_STATE="$(state_of "$TARGET")"
if [ "$TARGET_STATE" != "healthy" ] && [ "$TARGET_STATE" != "running" ]; then
  echo "ERROR: $TARGET state is '$TARGET_STATE' (not healthy/running)"
  exit 1
fi

CADDY_HOST_FILE="$(docker inspect "$EDGE" --format '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}')"
if [ -z "${CADDY_HOST_FILE:-}" ] || [ ! -f "$CADDY_HOST_FILE" ]; then
  echo "ERROR: could not find host-mounted Caddyfile for $EDGE"
  exit 1
fi

echo "Using color=$COLOR upstream=$UPSTREAM"
echo "Target state: $TARGET_STATE"
echo "Host Caddyfile: $CADDY_HOST_FILE"

# Backup
cp -a "$CADDY_HOST_FILE" "${CADDY_HOST_FILE}.bak.$(date +%Y%m%d_%H%M%S)"

tmp_body="$(mktemp)"
tmp_new="$(mktemp)"

# Escape domain for regex
domain_re="$(printf '%s' "$DOMAIN" | sed 's/[][(){}.^$+*?|\\/]/\\&/g')"

# Remove ALL existing api-bookhive site blocks (supports nested braces)
awk -v dr="$domain_re" '
function trim(s){sub(/^[ \t]+/,"",s); sub(/[ \t]+$/,"",s); return s}
function countc(s,c,  i,n){n=0; for(i=1;i<=length(s);i++) if(substr(s,i,1)==c) n++; return n}
BEGIN{skip=0; depth=0}
{
  line=$0
  t=trim(line)

  if(!skip && t ~ ("^" dr "([[:space:]]*:[0-9]+)?[[:space:]]*\\{[[:space:]]*$")) {
    skip=1
    depth=1
    next
  }

  if(skip){
    depth += countc(line,"{") - countc(line,"}")
    if(depth<=0){skip=0}
    next
  }

  print line
}
' "$CADDY_HOST_FILE" > "$tmp_body"

# Prepend canonical authoritative block
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
mv "$tmp_new" "$CADDY_HOST_FILE"
rm -f "$tmp_body"

# Remove stale imported conf.d route files that may conflict
docker exec "$EDGE" sh -lc 'rm -f /etc/caddy/conf.d/bookhive-api.caddy /etc/caddy/conf.d/*bookhive*api*.caddy 2>/dev/null || true'

# Validate + reload
docker exec "$EDGE" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker exec "$EDGE" caddy reload   --config /etc/caddy/Caddyfile --adapter caddyfile

# Update active marker
printf '%s\n' "$COLOR" > "$ACTIVE_FILE"
chmod 600 "$ACTIVE_FILE" || true

echo
echo "--- Effective api-bookhive block ---"
awk -v d="$DOMAIN" '
$0 ~ "^"d"([[:space:]]*:[0-9]+)?[[:space:]]*\\{" {p=1}
p{print}
p && /^\}/ {exit}
' "$CADDY_HOST_FILE"

echo
echo "--- Probe (MUST be plain text, not HTML) ---"
curl --resolve "${DOMAIN}:443:127.0.0.1" -ksS "https://${DOMAIN}/__edge_probe"; echo

echo
echo "--- /health headers (should include X-Bookhive-Backend) ---"
curl --resolve "${DOMAIN}:443:127.0.0.1" -kIs "https://${DOMAIN}/health" | sed -n '1,40p'
