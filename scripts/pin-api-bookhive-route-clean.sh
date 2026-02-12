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
  # 1) active marker if healthy/running
  if [ -f "$ACTIVE_FILE" ]; then
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

  # 2) newest healthy
  best=""
  best_epoch=0
  for c in blue green; do
    n="bookhive-api-$c"
    if exists "$n"; then
      s="$(state_of "$n")"
      if [ "$s" = "healthy" ]; then
        started="$(docker inspect --format '{{.State.StartedAt}}' "$n")"
        epoch="$(date -d "$started" +%s 2>/dev/null || echo 0)"
        if [ "$epoch" -gt "$best_epoch" ]; then
          best="$c"
          best_epoch="$epoch"
        fi
      fi
    fi
  done
  if [ -n "$best" ]; then
    echo "$best"; return 0
  fi

  # 3) any existing
  for c in blue green; do
    n="bookhive-api-$c"
    if exists "$n"; then
      echo "$c"; return 0
    fi
  done

  echo "ERROR: no bookhive-api-blue/green container found" >&2
  exit 1
}

COLOR="$(pick_color)"
TARGET="bookhive-api-$COLOR"
UPSTREAM="${TARGET}:3000"

echo "Using color=$COLOR upstream=$UPSTREAM"

S="$(state_of "$TARGET")"
if [ "$S" != "healthy" ] && [ "$S" != "running" ]; then
  echo "ERROR: $TARGET is not healthy/running (state=$S)" >&2
  exit 1
fi

HOST_CADDYFILE="$(docker inspect "$EDGE" --format '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}')"
if [ -z "${HOST_CADDYFILE:-}" ] || [ ! -f "$HOST_CADDYFILE" ]; then
  echo "ERROR: cannot find host-mounted Caddyfile for container $EDGE" >&2
  exit 1
fi

echo "Host Caddyfile: $HOST_CADDYFILE"
cp -a "$HOST_CADDYFILE" "${HOST_CADDYFILE}.bak.$(date +%Y%m%d_%H%M%S)"

python3 - "$HOST_CADDYFILE" "$DOMAIN" "$UPSTREAM" <<'PY'
import re, sys
path, domain, upstream = sys.argv[1], sys.argv[2], sys.argv[3]

with open(path, "r", encoding="utf-8") as f:
    lines = f.readlines()

# remove ALL existing site blocks for DOMAIN
pat = re.compile(r'^\s*' + re.escape(domain) + r'\s*\{\s*$')
out = []
i = 0
while i < len(lines):
    if pat.match(lines[i]):
        depth = 0
        while i < len(lines):
            depth += lines[i].count("{")
            depth -= lines[i].count("}")
            i += 1
            if depth <= 0:
                break
        continue
    out.append(lines[i])
    i += 1

block = f"""{domain} {{
    @probe path /__route_probe
    respond @probe "api-bookhive -> {upstream}"

    header X-Bookhive-Backend "{upstream}"
    reverse_proxy {upstream}
    encode gzip zstd
}}

"""

with open(path, "w", encoding="utf-8") as f:
    f.write(block)
    f.writelines(out)
PY

# remove stale conf.d override file from that same edge container
docker exec "$EDGE" sh -lc 'rm -f /etc/caddy/conf.d/bookhive-api.caddy || true'

docker exec "$EDGE" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker exec "$EDGE" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile

echo "$COLOR" > "$ACTIVE_FILE"
chmod 600 "$ACTIVE_FILE"

echo
echo "--- api-bookhive probe ---"
curl -ksS --resolve ${DOMAIN}:443:127.0.0.1 https://${DOMAIN}/__route_probe; echo

echo
echo "--- /health headers ---"
curl -ksSI --resolve ${DOMAIN}:443:127.0.0.1 https://${DOMAIN}/health | sed -n '1,40p'
