#!/usr/bin/env bash
set -Eeuo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck source=/dev/null
. "$REPO_DIR/.env"

: "${EXTERNAL_ENV_1:?EXTERNAL_ENV_1 missing in $REPO_DIR/.env}"
[[ -f "$EXTERNAL_ENV_1" ]] || { echo "[ERROR] External env not found: $EXTERNAL_ENV_1" >&2; exit 1; }

set -a
# shellcheck source=/dev/null
. "$EXTERNAL_ENV_1"
set +a
