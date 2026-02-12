#!/usr/bin/env bash
set -Eeuo pipefail

REQ_COLOR="${1:-auto}"                  # auto | blue | green
EDGE="${2:-workloadhub_caddy}"
DOMAIN="api-bookhive.jrmsu-tc.cloud"
ACTIVE_FILE="/opt/bookhive-env/bookhive-backend.active"

exists(){ docker inspect "$1" >/dev/null 2>&1; }
state_of(){ docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1" 2>/dev/null || true; }

pick_color() {
  if [[ "$REQ_COLOR" == "blue" || "$REQ_COLOR" == "green" ]]; then
    echo "$REQ_COLOR"; return 0
  fi

  # newest healthy first
  local best="" best_epoch=0
  for c in blue green; do
    local n="bookhive-api-$c"
    if exists "$n"; then
      local st started epoch
      st="$(state_of "$n")"
      if [[ "$st" == "healthy" ]]; then
        started="$(docker inspect --format '{{.State.StartedAt}}' "$n" 2>/dev/null || true)"
        epoch="$(date -d "$started" +%s 2>/dev/null || echo 0)"
        if (( epoch > best_epoch )); then
          best="$c"; best_epoch="$epoch"
        fi
      fi
    fi
  done
  if [[ -n "$best" ]]; then
    echo "$best"; return 0
  fi

  # active marker fallback
  if [[ -f "$ACTIVE_FILE" ]]; then
    local v
    v="$(tr -d ' \r\n' < "$ACTIVE_FILE" || true)"
    if [[ "$v" == "blue" || "$v" == "green" ]]; then
      echo "$v"; return 0
    fi
  fi

  # any running/healthy fallback
  for c in blue green; do
    local n="bookhive-api-$c"
    if exists "$n"; then
      local st
      st="$(state_of "$n")"
      if [[ "$st" == "healthy" || "$st" == "running" ]]; then
        echo "$c"; return 0
      fi
    fi
  done

  echo "blue"
}

validate_file() {
  local f="$1"
  docker run --rm -v "$f:/etc/caddy/Caddyfile:ro" caddy:2 \
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
}

# Resolve edge container if requested one missing
if ! exists "$EDGE"; then
  EDGE="$(docker ps -a --format '{{.Names}}' | grep -E '^workloadhub_caddy([_-].*)?$' | head -n1 || true)"
fi
[[ -n "${EDGE:-}" ]] || { echo "ERROR: No Caddy container found"; exit 1; }

# Host-mounted Caddyfile path
CFILE="$(docker inspect "$EDGE" --format '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}')"
[[ -n "${CFILE:-}" && -f "$CFILE" ]] || { echo "ERROR: Could not find host Caddyfile mount for $EDGE"; exit 1; }

echo "Edge container: $EDGE"
echo "Host Caddyfile: $CFILE"

TS="$(date +%Y%m%d_%H%M%S)"
cp -a "$CFILE" "${CFILE}.rescue.pre.${TS}"

# If current Caddyfile invalid, restore latest valid backup
if ! validate_file "$CFILE"; then
  echo "[WARN] Current Caddyfile is invalid. Looking for latest valid backup..."
  PICK=""
  while IFS= read -r f; do
    [[ -f "$f" ]] || continue
    if validate_file "$f"; then
      PICK="$f"
      break
    fi
  done < <(ls -1t "$CFILE".bak.* "$CFILE".fix.* "$CFILE".pre* "$CFILE".broken.* 2>/dev/null || true)

  [[ -n "$PICK" ]] || { echo "ERROR: No valid Caddyfile backup found."; exit 1; }
  echo "Restoring: $PICK"
  cp -a "$PICK" "$CFILE"
fi

COLOR="$(pick_color)"
UPSTREAM="bookhive-api-${COLOR}:3000"
echo "Pinning ${DOMAIN} -> ${UPSTREAM}"

export CFILE DOMAIN UPSTREAM
python3 - <<'PY'
from pathlib import Path
import os, re

p = Path(os.environ["CFILE"])
domain = os.environ["DOMAIN"]
up = os.environ["UPSTREAM"]

lines = p.read_text().splitlines(True)
pat = re.compile(r'^\s*' + re.escape(domain) + r'\s*\{\s*$')

out = []
i = 0
removed = 0
while i < len(lines):
    if pat.match(lines[i]):
        removed += 1
        depth = lines[i].count("{") - lines[i].count("}")
        i += 1
        while i < len(lines) and depth > 0:
            depth += lines[i].count("{") - lines[i].count("}")
            i += 1
        continue
    out.append(lines[i])
    i += 1

block = f'''{domain} {{
    @probe path /__edge_probe
    respond @probe 200 "api-bookhive -> {up}"

    reverse_proxy {up} {{
        header_down +X-Bookhive-Backend "{up}"
    }}

    encode gzip zstd
}}
'''

new_text = ''.join(out).rstrip() + "\n\n" + block
p.write_text(new_text)
print(f"Removed {removed} old block(s), appended new block for {up}")
PY

# Validate patched config; rollback on failure
if ! validate_file "$CFILE"; then
  echo "ERROR: Patched Caddyfile invalid. Rolling back."
  cp -a "${CFILE}.rescue.pre.${TS}" "$CFILE"
  exit 1
fi

echo "$COLOR" > "$ACTIVE_FILE"
chmod 600 "$ACTIVE_FILE" || true

# Restart edge cleanly
docker restart "$EDGE" >/dev/null

for i in $(seq 1 40); do
  st="$(docker inspect --format '{{.State.Status}}' "$EDGE" 2>/dev/null || true)"
  [[ "$st" == "running" ]] && break
  sleep 1
done

echo
docker ps --filter "name=^/${EDGE}$" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

echo
echo "--- Probe (must be plain text) ---"
curl --resolve "${DOMAIN}:443:127.0.0.1" -kfsS "https://${DOMAIN}/__edge_probe" || true
echo

echo
echo "--- Health headers (must include X-Bookhive-Backend) ---"
curl --resolve "${DOMAIN}:443:127.0.0.1" -kIs "https://${DOMAIN}/health" | sed -n '1,40p' || true
