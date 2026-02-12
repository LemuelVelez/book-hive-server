#!/usr/bin/env bash
set -Eeuo pipefail

DOMAIN="api-bookhive.jrmsu-tc.cloud"
CADDY_CONTAINER="workloadhub_caddy"
ACTIVE_FILE="/opt/bookhive-env/bookhive-backend.active"

# Discover host-mounted Caddyfile path from container mount
CADDY_HOST_FILE="$(docker inspect "$CADDY_CONTAINER" --format '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}')"
if [ -z "${CADDY_HOST_FILE:-}" ] || [ ! -f "$CADDY_HOST_FILE" ]; then
  echo "ERROR: could not find host Caddyfile mount for $CADDY_CONTAINER"
  exit 1
fi

pick_color() {
  # 1) active marker if valid + healthy
  if [ -f "$ACTIVE_FILE" ]; then
    c="$(tr -d ' \r\n' < "$ACTIVE_FILE" || true)"
    if [ "$c" = "blue" ] || [ "$c" = "green" ]; then
      n="bookhive-api-$c"
      if docker inspect "$n" >/dev/null 2>&1; then
        h="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$n" 2>/dev/null || true)"
        if [ "$h" = "healthy" ] || [ "$h" = "running" ]; then
          echo "$c"; return 0
        fi
      fi
    fi
  fi

  # 2) newest healthy among blue/green
  best=""; best_epoch=0
  for c in blue green; do
    n="bookhive-api-$c"
    if docker inspect "$n" >/dev/null 2>&1; then
      h="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$n" 2>/dev/null || true)"
      if [ "$h" = "healthy" ]; then
        s="$(docker inspect --format '{{.State.StartedAt}}' "$n" 2>/dev/null || true)"
        e="$(date -d "$s" +%s 2>/dev/null || echo 0)"
        if [ "$e" -gt "$best_epoch" ]; then best="$c"; best_epoch="$e"; fi
      fi
    fi
  done
  if [ -n "$best" ]; then echo "$best"; return 0; fi

  # 3) fallback existing
  for c in blue green; do
    docker inspect "bookhive-api-$c" >/dev/null 2>&1 && { echo "$c"; return 0; }
  done

  echo "blue"
}

COLOR="$(pick_color)"
UPSTREAM="bookhive-api-${COLOR}:3000"

echo "Using color=${COLOR}, upstream=${UPSTREAM}"
docker inspect "bookhive-api-${COLOR}" >/dev/null 2>&1 || { echo "ERROR: upstream container missing"; exit 1; }

# Backup
cp -a "$CADDY_HOST_FILE" "${CADDY_HOST_FILE}.bak.$(date +%Y%m%d_%H%M%S)"

# Remove ALL existing api-bookhive blocks from Caddyfile
tmp_clean="$(mktemp)"
awk -v d="$DOMAIN" '
BEGIN{skip=0;depth=0}
{
  line=$0

  # start skip when site line contains domain and opening brace
  if (skip==0 && line ~ d && line ~ /\{/) {
    skip=1
    t=line
    o=gsub(/\{/, "{", t)
    c=gsub(/\}/, "}", t)
    depth=o-c
    if (depth<=0) {skip=0; depth=0}
    next
  }

  if (skip==1) {
    t=line
    o=gsub(/\{/, "{", t)
    c=gsub(/\}/, "}", t)
    depth += (o-c)
    if (depth<=0) {skip=0; depth=0}
    next
  }

  print line
}
' "$CADDY_HOST_FILE" > "$tmp_clean"

# Prepend authoritative block at TOP so it wins route order
tmp_new="$(mktemp)"
cat > "$tmp_new" <<BLOCK
${DOMAIN} {
    header X-Bookhive-Backend "${UPSTREAM}"
    reverse_proxy ${UPSTREAM}
    encode gzip zstd
}

BLOCK
cat "$tmp_clean" >> "$tmp_new"
install -m 644 "$tmp_new" "$CADDY_HOST_FILE"
rm -f "$tmp_clean" "$tmp_new"

# Remove stale conf.d domain fragments to avoid duplicate hosts
docker exec "$CADDY_CONTAINER" sh -lc \
'if [ -d /etc/caddy/conf.d ]; then
   grep -R -l "api-bookhive.jrmsu-tc.cloud" /etc/caddy/conf.d 2>/dev/null | xargs -r rm -f
 fi'

# Validate and reload
docker exec "$CADDY_CONTAINER" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile

# Persist selected color
printf '%s\n' "$COLOR" > "$ACTIVE_FILE"
chmod 600 "$ACTIVE_FILE" || true

echo
echo "--- Effective api-bookhive block (top of host Caddyfile) ---"
awk -v d="$DOMAIN" '
$0 ~ "^[[:space:]]*" d "[[:space:]]*\\{" {p=1}
p {print}
p && $0 ~ /^[[:space:]]*}[[:space:]]*$/ {exit}
' "$CADDY_HOST_FILE"

echo
echo "--- Verify headers ---"
curl -sSI "https://${DOMAIN}/health" | tr -d '\r' | sed -n '1,30p'
echo
echo "--- Verify backend marker header present ---"
curl -sSI "https://${DOMAIN}/health" | tr -d '\r' | grep -i '^X-Bookhive-Backend:' || {
  echo "WARN: X-Bookhive-Backend header not found."
  echo "      If health is 200 but marker missing, another edge layer may still be answering first."
}
