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

  # any existing fallback
  for c in blue green; do
    if exists "bookhive-api-$c"; then
      echo "$c"; return 0
    fi
  done

  echo "blue"
}

EDGE_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$EDGE" 2>/dev/null || true)"
[[ -n "${EDGE_IMAGE:-}" ]] || { echo "ERROR: edge container '$EDGE' not found"; exit 1; }

HOST_CADDY="$(docker inspect "$EDGE" --format '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}')"
[[ -n "${HOST_CADDY:-}" && -f "$HOST_CADDY" ]] || { echo "ERROR: cannot locate host-mounted Caddyfile for $EDGE"; exit 1; }

validate_file() {
  local f="$1"
  docker run --rm -v "$f:/etc/caddy/Caddyfile:ro" "$EDGE_IMAGE" \
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
}

COLOR="$(pick_color)"
UPSTREAM="bookhive-api-${COLOR}:3000"

echo "Edge container : $EDGE"
echo "Edge image     : $EDGE_IMAGE"
echo "Host Caddyfile : $HOST_CADDY"
echo "Using color    : $COLOR ($UPSTREAM)"

# Ensure chosen backend exists
if ! exists "$UPSTREAM"; then
  echo "WARN: target container '$UPSTREAM' not found. Continuing anyway."
fi

# Validate current file; auto-restore newest valid backup if broken
if ! validate_file "$HOST_CADDY"; then
  echo "[WARN] Current Caddyfile invalid; searching backups..."
  mapfile -t BAKS < <(ls -1t "${HOST_CADDY}".bak.* 2>/dev/null || true)
  restored=0
  for b in "${BAKS[@]}"; do
    if validate_file "$b"; then
      echo "Restoring valid backup: $b"
      cp -a "$b" "$HOST_CADDY"
      restored=1
      break
    fi
  done
  [[ "$restored" -eq 1 ]] || { echo "ERROR: no valid backup found."; exit 1; }
fi

TMP="$(mktemp)"
python3 - "$HOST_CADDY" "$TMP" "$DOMAIN" "$UPSTREAM" <<'PY'
import re, sys
src, dst, domain, upstream = sys.argv[1:5]
text = open(src, "r", encoding="utf-8").read().splitlines(True)

pat = re.compile(r'^\s*' + re.escape(domain) + r'\s*\{\s*$')
out = []
i = 0
removed = 0

while i < len(text):
    line = text[i]
    if pat.match(line):
        removed += 1
        depth = line.count("{") - line.count("}")
        i += 1
        while i < len(text) and depth > 0:
            depth += text[i].count("{") - text[i].count("}")
            i += 1
        # trim extra blank lines directly after removed block
        while i < len(text) and text[i].strip() == "":
            i += 1
        continue
    out.append(line)
    i += 1

if out and not out[-1].endswith("\n"):
    out[-1] += "\n"
if out and out[-1].strip() != "":
    out.append("\n")

block = f"""{domain} {{
    @probe path /__edge_probe
    respond @probe "api-bookhive -> {upstream}" 200

    encode zstd gzip

    reverse_proxy {upstream} {{
        header_down +X-Bookhive-Backend "{upstream}"
    }}
}}
"""
out.append(block)

open(dst, "w", encoding="utf-8").write("".join(out))
print(f"removed_blocks={removed}")
PY

# Validate candidate before replacing
if ! validate_file "$TMP"; then
  echo "ERROR: generated Caddyfile is invalid; not applying."
  echo "----- candidate tail -----"
  tail -n 80 "$TMP" || true
  rm -f "$TMP"
  exit 1
fi

STAMP="$(date +%Y%m%d_%H%M%S)"
cp -a "$HOST_CADDY" "${HOST_CADDY}.bak.${STAMP}"
install -m 0644 "$TMP" "$HOST_CADDY"
rm -f "$TMP"

# Apply config
if docker inspect "$EDGE" >/dev/null 2>&1; then
  if docker exec "$EDGE" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
    echo "Caddy reloaded."
  else
    echo "[WARN] reload failed; restarting $EDGE..."
    docker restart "$EDGE" >/dev/null
  fi
else
  echo "ERROR: edge container not found after apply."
  exit 1
fi

# Wait for edge running
for i in $(seq 1 40); do
  st="$(docker inspect --format '{{.State.Status}}' "$EDGE" 2>/dev/null || true)"
  [[ "$st" == "running" ]] && break
  sleep 1
done
st="$(docker inspect --format '{{.State.Status}}' "$EDGE" 2>/dev/null || true)"
[[ "$st" == "running" ]] || { echo "ERROR: $EDGE not running"; docker logs --tail 120 "$EDGE" || true; exit 1; }

# Save active marker
mkdir -p "$(dirname "$ACTIVE_FILE")"
echo "$COLOR" > "$ACTIVE_FILE"

echo
echo "--- Probe (must be plain text) ---"
ok=0
for i in $(seq 1 20); do
  body="$(curl --resolve "${DOMAIN}:443:127.0.0.1" -ksS "https://${DOMAIN}/__edge_probe" || true)"
  if [[ "$body" == "api-bookhive -> ${UPSTREAM}" ]]; then
    echo "$body"
    ok=1
    break
  fi
  sleep 1
done
[[ "$ok" -eq 1 ]] || {
  echo "WARN: probe didn't match yet."
  echo "Got:"
  curl --resolve "${DOMAIN}:443:127.0.0.1" -ksS "https://${DOMAIN}/__edge_probe" | sed -n '1,40p' || true
}

echo
echo "--- /health headers (expect X-Bookhive-Backend) ---"
curl --resolve "${DOMAIN}:443:127.0.0.1" -kIs "https://${DOMAIN}/health" | sed -n '1,60p' || true

echo
echo "--- edge status ---"
docker ps --filter "name=^/${EDGE}$" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
