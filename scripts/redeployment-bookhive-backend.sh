#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="/root/book-hive-server"
CORE_SCRIPT="$APP_DIR/scripts/redeployment-bookhive.sh"
ENV_LOADER_ABS="$APP_DIR/scripts/load-external-env-backend.sh"

[[ -f "$CORE_SCRIPT" ]] || { echo "[ERROR] Missing core script: $CORE_SCRIPT" >&2; exit 1; }
[[ -f "$ENV_LOADER_ABS" ]] || { echo "[ERROR] Missing env loader: $ENV_LOADER_ABS" >&2; exit 1; }

# Default compose (override by exporting COMPOSE_FILE)
if [[ -z "${COMPOSE_FILE:-}" ]]; then
  COMPOSE_FILE="/root/book-hive/docker-compose.yml"
fi
[[ -f "$COMPOSE_FILE" ]] || { echo "[ERROR] Compose file not found: $COMPOSE_FILE" >&2; exit 1; }

REPO_DIR_ABS="$(cd "$(dirname "$COMPOSE_FILE")" && pwd)"

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

# Blue/green (you already confirmed these service names)
export BLUE_SVC="${BLUE_SVC:-bookhive-blue}"
export GREEN_SVC="${GREEN_SVC:-bookhive-green}"
export BLUE_PORT="${BLUE_PORT:-18081}"
export GREEN_PORT="${GREEN_PORT:-18082}"

echo "[INFO] REPO_DIR=$REPO_DIR"
echo "[INFO] COMPOSE_FILE=$COMPOSE_FILE"
echo "[INFO] CADDY_REPO_FILE=$CADDY_REPO_FILE"
echo "[INFO] ENV_LOADER=$ENV_LOADER"
echo "[INFO] DOMAIN=$DOMAIN"
echo "[INFO] BLUE=$BLUE_SVC:$BLUE_PORT GREEN=$GREEN_SVC:$GREEN_PORT"

exec "$CORE_SCRIPT"
