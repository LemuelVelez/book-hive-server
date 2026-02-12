#!/usr/bin/env bash
set -Eeuo pipefail

FILE="$HOME/book-hive-server/scripts/redeployment-bookhive.sh"
[[ -f "$FILE" ]] || { echo "[ERROR] Missing $FILE" >&2; exit 1; }

sed -i 's|^BLUE_SVC="bookhive-blue"$|BLUE_SVC="${BLUE_SVC:-bookhive-blue}"|' "$FILE"
sed -i 's|^GREEN_SVC="bookhive-green"$|GREEN_SVC="${GREEN_SVC:-bookhive-green}"|' "$FILE"
sed -i 's|^BLUE_PORT="18081"$|BLUE_PORT="${BLUE_PORT:-18081}"|' "$FILE"
sed -i 's|^GREEN_PORT="18082"$|GREEN_PORT="${GREEN_PORT:-18082}"|' "$FILE"
sed -i 's|log "2) Load external frontend env"|log "2) Load external env"|' "$FILE" || true

chmod +x "$FILE"
echo "[OK] Patched $FILE"
