#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ACTION="${1:-deploy}"
ROLLBACK_COLOR="${2:-}"

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.bookhive-backend.yml}"
DOMAIN="${DOMAIN:-api-bookhive.jrmsu-tc.cloud}"
NETWORK="${NETWORK:-bookhive_backend_net}"
CADDY_CONTAINER="${CADDY_CONTAINER:-}"
CADDYFILE_IN_CONTAINER="${CADDYFILE_IN_CONTAINER:-/etc/caddy/Caddyfile}"
CONF_D_DIR_IN_CONTAINER="${CONF_D_DIR_IN_CONTAINER:-/etc/caddy/conf.d}"
SNIPPET_FILE_IN_CONTAINER="${SNIPPET_FILE_IN_CONTAINER:-/etc/caddy/conf.d/bookhive-api.caddy}"
KEEP_OLD="${KEEP_OLD:-1}"

STATE_DIR="$ROOT_DIR/.deploy"
STATE_FILE="$STATE_DIR/bookhive_active_color"
TMP_SNIPPET="$STATE_DIR/bookhive-api.caddy"
LOCK_DIR="$STATE_DIR/.deploy-lock"

mkdir -p "$STATE_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is not installed"
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose plugin is missing"
  exit 1
fi

lock_or_exit() {
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "another deployment is running (lock exists: $LOCK_DIR)"
    exit 1
  fi
}

unlock() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
}

trap unlock EXIT

find_caddy_container() {
  if [ -n "$CADDY_CONTAINER" ]; then
    if docker ps --format '{{.Names}}' | grep -qx "$CADDY_CONTAINER"; then
      return 0
    fi
    echo "CADDY_CONTAINER=$CADDY_CONTAINER is not running"
    exit 1
  fi

  CADDY_CONTAINER="$(docker ps --format '{{.Names}} {{.Image}} {{.Ports}}' | awk 'tolower($0) ~ /caddy/ && ($0 ~ /:80->/ || $0 ~ /:443->/) {print $1; exit}')"

  if [ -z "$CADDY_CONTAINER" ]; then
    CADDY_CONTAINER="$(docker ps --format '{{.Names}} {{.Image}}' | awk 'tolower($0) ~ /caddy/ {print $1; exit}')"
  fi

  if [ -z "$CADDY_CONTAINER" ]; then
    echo "No running Caddy container found."
    echo "Start your edge Caddy first, or set CADDY_CONTAINER=<container_name>."
    exit 1
  fi
}

get_active_color() {
  local color=""

  if [ -f "$STATE_FILE" ]; then
    color="$(tr -d '[:space:]' < "$STATE_FILE")"
  fi

  if [ "$color" != "blue" ] && [ "$color" != "green" ]; then
    color="$(docker exec "$CADDY_CONTAINER" sh -lc "if [ -f '$SNIPPET_FILE_IN_CONTAINER' ]; then grep -Eo 'bookhive-api-(blue|green):3000' '$SNIPPET_FILE_IN_CONTAINER' | tail -n1; fi" 2>/dev/null | sed -E 's/.*-(blue|green):3000/\1/' || true)"
  fi

  if [ "$color" != "blue" ] && [ "$color" != "green" ]; then
    color="none"
  fi

  echo "$color"
}

wait_for_container() {
  local container="$1"
  local max_tries=60
  local try=1

  while [ "$try" -le "$max_tries" ]; do
    local state health
    state="$(docker inspect --format '{{.State.Status}}' "$container" 2>/dev/null || true)"
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 2>/dev/null || true)"

    if [ "$state" = "running" ] && { [ "$health" = "healthy" ] || [ "$health" = "none" ]; }; then
      if docker exec "$container" sh -lc "node -e \"const http=require('http');const p=process.env.PORT||3000;const req=http.get({host:'127.0.0.1',port:p,path:'/',timeout:1500},res=>process.exit(res.statusCode<500?0:1));req.on('error',()=>process.exit(1));req.on('timeout',()=>{req.destroy();process.exit(1);});\"" >/dev/null 2>&1; then
        return 0
      fi
    fi

    sleep 2
    try=$((try + 1))
  done

  return 1
}

switch_caddy_to_color() {
  local color="$1"
  local import_line="import ${CONF_D_DIR_IN_CONTAINER}/*.caddy"

  cat > "$TMP_SNIPPET" <<EOF2
${DOMAIN} {
    encode gzip zstd
    reverse_proxy bookhive-api-${color}:3000
}
EOF2

  # Reuse existing edge Caddy and attach it to this isolated backend network.
  docker network connect "$NETWORK" "$CADDY_CONTAINER" >/dev/null 2>&1 || true

  docker exec "$CADDY_CONTAINER" sh -lc "mkdir -p '$CONF_D_DIR_IN_CONTAINER'"
  docker cp "$TMP_SNIPPET" "$CADDY_CONTAINER:$SNIPPET_FILE_IN_CONTAINER"

  # Ensure Caddyfile imports conf.d snippets.
  docker exec "$CADDY_CONTAINER" sh -lc "grep -qF '$import_line' '$CADDYFILE_IN_CONTAINER' || sed -i '1i $import_line' '$CADDYFILE_IN_CONTAINER'"

  docker exec "$CADDY_CONTAINER" caddy reload --config "$CADDYFILE_IN_CONTAINER" --adapter caddyfile
}

check_public_endpoint() {
  local tries=30
  local i=1

  while [ "$i" -le "$tries" ]; do
    if curl -fsS "https://${DOMAIN}/health" >/dev/null 2>&1 || curl -fsS "https://${DOMAIN}/" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
    i=$((i + 1))
  done

  return 1
}

show_status() {
  find_caddy_container
  local active
  active="$(get_active_color)"

  echo "Compose file : $COMPOSE_FILE"
  echo "Domain       : $DOMAIN"
  echo "Caddy        : $CADDY_CONTAINER"
  echo "Active color : $active"
  echo

  docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}' | grep -E 'bookhive-api-(blue|green)|NAMES' || true
}

rollback_to_color() {
  local color="$1"
  if [ "$color" != "blue" ] && [ "$color" != "green" ]; then
    echo "rollback color must be: blue or green"
    exit 1
  fi

  find_caddy_container
  switch_caddy_to_color "$color"
  echo "$color" > "$STATE_FILE"
  echo "Rollback complete. Active color is now: $color"
}

deploy() {
  lock_or_exit

  # Keep your existing env loader behavior if present.
  if [ -x "$ROOT_DIR/scripts/load-external-env-backend.sh" ]; then
    "$ROOT_DIR/scripts/load-external-env-backend.sh" || true
  fi

  find_caddy_container

  local active target old_service target_service
  active="$(get_active_color)"

  if [ "$active" = "blue" ]; then
    target="green"
  else
    target="blue"
  fi

  old_service="bookhive-api-${active}"
  target_service="bookhive-api-${target}"

  echo "Current active color: $active"
  echo "Deploying target color: $target"

  docker compose -f "$COMPOSE_FILE" --env-file .env up -d --build --no-deps "$target_service"

  echo "Waiting for $target_service to be healthy..."
  if ! wait_for_container "$target_service"; then
    echo "Target container failed health checks: $target_service"
    exit 1
  fi

  echo "Switching Caddy route to $target..."
  switch_caddy_to_color "$target"

  echo "Checking public HTTPS endpoint..."
  if ! check_public_endpoint; then
    echo "Public check failed after switch. Rolling back route to $active"
    if [ "$active" = "blue" ] || [ "$active" = "green" ]; then
      switch_caddy_to_color "$active" || true
      echo "$active" > "$STATE_FILE"
    fi
    exit 1
  fi

  echo "$target" > "$STATE_FILE"

  # KEEP_OLD=1 keeps previous color running for instant rollback.
  if [ "$KEEP_OLD" = "0" ] && { [ "$active" = "blue" ] || [ "$active" = "green" ]; }; then
    docker compose -f "$COMPOSE_FILE" --env-file .env stop "$old_service" || true
  fi

  echo "Deployment successful. Active color: $target"
  echo "Public URL: https://${DOMAIN}/"
}

case "$ACTION" in
  deploy)
    deploy
    ;;
  status)
    show_status
    ;;
  rollback)
    rollback_to_color "$ROLLBACK_COLOR"
    ;;
  *)
    echo "Usage: $0 [deploy|status|rollback <blue|green>]"
    exit 1
    ;;
esac
