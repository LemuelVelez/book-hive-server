#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/.."

export BOOKHIVE_BACKEND_EXTERNAL_ENV=/opt/bookhive-env/bookhive-backend.env
./scripts/load-external-env-backend.sh
./scripts/fix-bookhive-db-connrefused.sh || true
./scripts/ensure-bookhive-db-dns.sh || true

# Keep blue/green deploy flow, tolerate old in-container Caddyfile edit failure
./scripts/redeployment-bookhive-backend.sh deploy || \
  echo "[WARN] redeploy returned non-zero (expected if old script still edits /etc/caddy/Caddyfile in-container)."

# Authoritative host-mounted Caddyfile repair + pin
./scripts/recover-and-pin-api-bookhive-v4.sh auto workloadhub_caddy

./scripts/redeployment-bookhive-backend.sh status || true
