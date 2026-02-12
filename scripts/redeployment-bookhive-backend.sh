#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
CORE_SCRIPT="${CORE_SCRIPT:-$SCRIPT_DIR/redeployment-bookhive.sh}"
ENV_LOADER_ABS="${ENV_LOADER_ABS:-$SCRIPT_DIR/load-external-env-backend.sh}"

[[ -f "$CORE_SCRIPT" ]] || { echo "[ERROR] Missing core script: $CORE_SCRIPT" >&2; exit 1; }
[[ -f "$ENV_LOADER_ABS" ]] || { echo "[ERROR] Missing env loader: $ENV_LOADER_ABS" >&2; exit 1; }

# Backend repo only
APP_DIR="${APP_DIR:-/root/book-hive-server}"

# Backend defaults (override if your compose uses other names)
BLUE_SVC="${BLUE_SVC:-bookhive-api-blue}"
GREEN_SVC="${GREEN_SVC:-bookhive-api-green}"
BLUE_PORT="${BLUE_PORT:-28081}"
GREEN_PORT="${GREEN_PORT:-28082}"
UPSTREAM_CONTAINER_PORT="${UPSTREAM_CONTAINER_PORT:-8080}"

# Health path for API readiness/public verification
HEALTH_PATH="${HEALTH_PATH:-/health}"

resolve_path() {
  local p="$1"
  if [[ "$p" = /* ]]; then
    printf '%s\n' "$p"
  else
    printf '%s\n' "$APP_DIR/$p"
  fi
}

# Compose selection: backend-first, no frontend fallback
if [[ -n "${COMPOSE_FILE:-}" ]]; then
  COMPOSE_FILE="$(resolve_path "$COMPOSE_FILE")"
else
  for f in \
    "$APP_DIR/docker-compose.backend.yml" \
    "$APP_DIR/docker-compose.backend.yaml" \
    "$APP_DIR/docker-compose.api.yml" \
    "$APP_DIR/docker-compose.api.yaml" \
    "$APP_DIR/compose.backend.yml" \
    "$APP_DIR/compose.backend.yaml" \
    "$APP_DIR/docker-compose.yml" \
    "$APP_DIR/compose.yml" \
    "$APP_DIR/compose.yaml"
  do
    [[ -f "$f" ]] && { COMPOSE_FILE="$f"; break; }
  done
fi

[[ -f "${COMPOSE_FILE:-}" ]] || {
  echo "[ERROR] Backend compose file not found under APP_DIR=$APP_DIR" >&2
  find "$APP_DIR" -maxdepth 6 -type f \( \
    -name 'docker-compose*.yml' -o -name 'docker-compose*.yaml' -o \
    -name 'compose*.yml' -o -name 'compose*.yaml' \
  \) | sort >&2 || true
  exit 1
}

# Hard guard: never allow frontend compose in backend deploy
if [[ "$(basename "$COMPOSE_FILE")" =~ frontend ]]; then
  echo "[ERROR] Backend script resolved a FRONTEND compose file: $COMPOSE_FILE" >&2
  exit 1
fi

REPO_DIR_ABS="$(cd "$(dirname "$COMPOSE_FILE")" && pwd -P)"

# Caddyfile preference: runtime-mounted first
if [[ -z "${CADDY_REPO_FILE:-}" ]]; then
  if [[ -f "/opt/workloadhub-stack/Caddyfile" ]]; then
    CADDY_REPO_FILE="/opt/workloadhub-stack/Caddyfile"
  elif [[ -f "$REPO_DIR_ABS/infra/Caddyfile" ]]; then
    CADDY_REPO_FILE="$REPO_DIR_ABS/infra/Caddyfile"
  elif [[ -f "/etc/caddy/Caddyfile" ]]; then
    CADDY_REPO_FILE="/etc/caddy/Caddyfile"
  else
    echo "[ERROR] No Caddyfile found." >&2
    exit 1
  fi
fi

# Auto-adopt existing compose project label if present
if [[ -z "${COMPOSE_PROJECT_NAME:-}" ]]; then
  for c in "$BLUE_SVC" "$GREEN_SVC"; do
    if docker ps -a --format '{{.Names}}' | grep -Fxq "$c"; then
      COMPOSE_PROJECT_NAME="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$c" 2>/dev/null || true)"
      [[ -n "$COMPOSE_PROJECT_NAME" ]] && break
    fi
  done
fi

export REPO_DIR="${REPO_DIR:-$REPO_DIR_ABS}"
export COMPOSE_FILE
export ENV_LOADER="${ENV_LOADER:-$ENV_LOADER_ABS}"
export CADDY_REPO_FILE
export ACTIVE_MARKER="${ACTIVE_MARKER:-/opt/bookhive-env/bookhive-backend.active}"

export DOMAIN="${DOMAIN:-api-bookhive.jrmsu-tc.cloud}"
export HEALTH_PATH
export PUBLIC_CHECK_URL="${PUBLIC_CHECK_URL:-https://${DOMAIN}${HEALTH_PATH}}"

export SLOT_HEADER_NAME="${SLOT_HEADER_NAME:-X-BookHive-API-Slot}"
export REQUIRED_ENV_KEY="${REQUIRED_ENV_KEY:-}"

export BLUE_SVC GREEN_SVC BLUE_PORT GREEN_PORT
export UPSTREAM_CONTAINER_PORT

if [[ -n "${COMPOSE_PROJECT_NAME:-}" ]]; then
  export COMPOSE_PROJECT_NAME
fi

compose_cmd=(docker compose --project-directory "$REPO_DIR" -f "$COMPOSE_FILE")
if [[ -n "${COMPOSE_PROJECT_NAME:-}" ]]; then
  compose_cmd+=(--project-name "$COMPOSE_PROJECT_NAME")
fi

mapfile -t _svcs < <("${compose_cmd[@]}" config --services 2>/dev/null || true)
if ((${#_svcs[@]} > 0)); then
  printf '%s\n' "${_svcs[@]}" | grep -qx "$BLUE_SVC" || {
    echo "[ERROR] Service '$BLUE_SVC' not found in $COMPOSE_FILE" >&2
    echo "Available: ${_svcs[*]}" >&2
    exit 1
  }
  printf '%s\n' "${_svcs[@]}" | grep -qx "$GREEN_SVC" || {
    echo "[ERROR] Service '$GREEN_SVC' not found in $COMPOSE_FILE" >&2
    echo "Available: ${_svcs[*]}" >&2
    exit 1
  }
fi

echo "[INFO] APP_DIR=$APP_DIR"
echo "[INFO] REPO_DIR=$REPO_DIR"
echo "[INFO] COMPOSE_FILE=$COMPOSE_FILE"
echo "[INFO] CADDY_REPO_FILE=$CADDY_REPO_FILE"
echo "[INFO] DOMAIN=$DOMAIN"
echo "[INFO] PUBLIC_CHECK_URL=$PUBLIC_CHECK_URL"
echo "[INFO] SLOT_HEADER_NAME=$SLOT_HEADER_NAME"
[[ -n "${COMPOSE_PROJECT_NAME:-}" ]] && echo "[INFO] COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT_NAME"
echo "[INFO] BLUE=$BLUE_SVC:$BLUE_PORT GREEN=$GREEN_SVC:$GREEN_PORT"

exec "$CORE_SCRIPT"
