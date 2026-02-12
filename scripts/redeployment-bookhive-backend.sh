#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
APP_DIR="${APP_DIR:-$(cd "$SCRIPT_DIR/.." && pwd -P)}"

CORE_SCRIPT="${CORE_SCRIPT:-$SCRIPT_DIR/redeployment-bookhive.sh}"
ENV_LOADER_ABS="${ENV_LOADER_ABS:-$SCRIPT_DIR/load-external-env-backend.sh}"

[[ -f "$CORE_SCRIPT" ]] || { echo "[ERROR] Missing core script: $CORE_SCRIPT" >&2; exit 1; }
[[ -f "$ENV_LOADER_ABS" ]] || { echo "[ERROR] Missing env loader: $ENV_LOADER_ABS" >&2; exit 1; }

resolve_path() {
  local p="$1"
  if [[ "$p" = /* ]]; then
    printf '%s\n' "$p"
  else
    printf '%s\n' "$APP_DIR/$p"
  fi
}

# Compose file resolution:
# 1) user-provided COMPOSE_FILE (absolute or relative to APP_DIR)
# 2) auto-detect known backend/common compose filenames
if [[ -n "${COMPOSE_FILE:-}" ]]; then
  COMPOSE_FILE="$(resolve_path "$COMPOSE_FILE")"
else
  for f in \
    "$APP_DIR/docker-compose.backend.yml" \
    "$APP_DIR/docker-compose.server.yml" \
    "$APP_DIR/docker-compose.api.yml" \
    "$APP_DIR/docker-compose.yml" \
    "$APP_DIR/compose.backend.yml" \
    "$APP_DIR/compose.yml"
  do
    if [[ -f "$f" ]]; then
      COMPOSE_FILE="$f"
      break
    fi
  done
fi

[[ -n "${COMPOSE_FILE:-}" && -f "$COMPOSE_FILE" ]] || {
  echo "[ERROR] Compose file not found." >&2
  echo "Tried common names under: $APP_DIR" >&2
  echo "Use explicit override, e.g.:" >&2
  echo "  COMPOSE_FILE=$APP_DIR/docker-compose.backend.yml $SCRIPT_DIR/redeployment-bookhive-backend.sh" >&2
  echo "Available compose-like files:" >&2
  ls -1 "$APP_DIR"/*compose*.yml 2>/dev/null || true
  exit 1
}

REPO_DIR_ABS="$(cd "$(dirname "$COMPOSE_FILE")" && pwd -P)"

# Default Caddyfile (override via CADDY_REPO_FILE)
if [[ -z "${CADDY_REPO_FILE:-}" ]]; then
  if [[ -f "$REPO_DIR_ABS/infra/Caddyfile" ]]; then
    CADDY_REPO_FILE="$REPO_DIR_ABS/infra/Caddyfile"
  elif [[ -f "/etc/caddy/Caddyfile" ]]; then
    CADDY_REPO_FILE="/etc/caddy/Caddyfile"
  else
    echo "[ERROR] No Caddyfile found (infra/Caddyfile or /etc/caddy/Caddyfile)." >&2
    exit 1
  fi
fi

export REPO_DIR="${REPO_DIR:-$REPO_DIR_ABS}"
export COMPOSE_FILE
export ENV_LOADER="${ENV_LOADER:-$ENV_LOADER_ABS}"
export CADDY_REPO_FILE
export ACTIVE_MARKER="${ACTIVE_MARKER:-/opt/bookhive-env/bookhive-backend.active}"

# Backend domain
export DOMAIN="${DOMAIN:-api-bookhive.jrmsu-tc.cloud}"
export PUBLIC_CHECK_URL="${PUBLIC_CHECK_URL:-https://${DOMAIN}}"

# Blue/green
export BLUE_SVC="${BLUE_SVC:-bookhive-blue}"
export GREEN_SVC="${GREEN_SVC:-bookhive-green}"
export BLUE_PORT="${BLUE_PORT:-18081}"
export GREEN_PORT="${GREEN_PORT:-18082}"

# Deterministic compose project
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-bookhive-backend}"

# Validate services if docker compose config can be resolved at this stage.
# If config fails (e.g., env vars loaded later by core script), warn and continue.
mapfile -t _svcs < <(
  docker compose \
    --project-directory "$REPO_DIR" \
    --project-name "$COMPOSE_PROJECT_NAME" \
    -f "$COMPOSE_FILE" config --services 2>/dev/null || true
)

if ((${#_svcs[@]} > 0)); then
  printf '%s\n' "${_svcs[@]}" | grep -qx "$BLUE_SVC"  || {
    echo "[ERROR] Service '$BLUE_SVC' not found in $COMPOSE_FILE" >&2; exit 1; }
  printf '%s\n' "${_svcs[@]}" | grep -qx "$GREEN_SVC" || {
    echo "[ERROR] Service '$GREEN_SVC' not found in $COMPOSE_FILE" >&2; exit 1; }
else
  echo "[WARN] Could not validate compose services at wrapper stage (config unresolved). Continuing..."
fi

echo "[INFO] APP_DIR=$APP_DIR"
echo "[INFO] REPO_DIR=$REPO_DIR"
echo "[INFO] COMPOSE_FILE=$COMPOSE_FILE"
echo "[INFO] COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT_NAME"
echo "[INFO] CADDY_REPO_FILE=$CADDY_REPO_FILE"
echo "[INFO] ENV_LOADER=$ENV_LOADER"
echo "[INFO] DOMAIN=$DOMAIN"
echo "[INFO] BLUE=$BLUE_SVC:$BLUE_PORT GREEN=$GREEN_SVC:$GREEN_PORT"

exec "$CORE_SCRIPT"
