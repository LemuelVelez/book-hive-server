#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="/root/book-hive-server"
CORE_SCRIPT="$APP_DIR/scripts/redeployment-bookhive.sh"
ENV_LOADER_ABS="$APP_DIR/scripts/load-external-env-backend.sh"

[[ -f "$CORE_SCRIPT" ]] || { echo "[ERROR] Missing core script: $CORE_SCRIPT" >&2; exit 1; }
[[ -f "$ENV_LOADER_ABS" ]] || { echo "[ERROR] Missing env loader: $ENV_LOADER_ABS" >&2; exit 1; }

# Default compose (backend)
if [[ -z "${COMPOSE_FILE:-}" ]]; then
  COMPOSE_FILE="$APP_DIR/docker-compose.yml"
fi
[[ -f "$COMPOSE_FILE" ]] || { echo "[ERROR] Compose file not found: $COMPOSE_FILE" >&2; exit 1; }

REPO_DIR_ABS="$(cd "$(dirname "$COMPOSE_FILE")" && pwd -P)"

# Default Caddyfile (override by exporting CADDY_REPO_FILE)
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

# Keep compose project deterministic
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-bookhive-backend}"

# Validate that selected compose file actually contains expected services
mapfile -t _svcs < <(
  docker compose \
    --project-directory "$REPO_DIR" \
    --project-name "$COMPOSE_PROJECT_NAME" \
    -f "$COMPOSE_FILE" config --services 2>/dev/null || true
)

printf '%s\n' "${_svcs[@]}" | grep -qx "$BLUE_SVC"  || {
  echo "[ERROR] Service '$BLUE_SVC' not found in $COMPOSE_FILE" >&2; exit 1; }
printf '%s\n' "${_svcs[@]}" | grep -qx "$GREEN_SVC" || {
  echo "[ERROR] Service '$GREEN_SVC' not found in $COMPOSE_FILE" >&2; exit 1; }

echo "[INFO] REPO_DIR=$REPO_DIR"
echo "[INFO] COMPOSE_FILE=$COMPOSE_FILE"
echo "[INFO] COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT_NAME"
echo "[INFO] CADDY_REPO_FILE=$CADDY_REPO_FILE"
echo "[INFO] ENV_LOADER=$ENV_LOADER"
echo "[INFO] DOMAIN=$DOMAIN"
echo "[INFO] BLUE=$BLUE_SVC:$BLUE_PORT GREEN=$GREEN_SVC:$GREEN_PORT"

exec "$CORE_SCRIPT"
