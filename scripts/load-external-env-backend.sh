#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_ENV="$ROOT_DIR/.env"
EXT_ENV="${BOOKHIVE_BACKEND_EXTERNAL_ENV:-/opt/bookhive-env/bookhive-backend.env}"

touch "$TARGET_ENV"
sed -i 's/\r$//' "$TARGET_ENV"

if [ ! -f "$EXT_ENV" ]; then
  echo "ERROR: external env not found: $EXT_ENV"
  exit 1
fi

tmp="$(mktemp)"
cp "$TARGET_ENV" "$tmp"

# merge external key=value into project .env
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    ''|\#*) continue ;;
    *=*)
      key="${line%%=*}"
      grep -v "^${key}=" "$tmp" > "${tmp}.new" || true
      printf '%s\n' "$line" >> "${tmp}.new"
      mv "${tmp}.new" "$tmp"
      ;;
  esac
done < "$EXT_ENV"

mv "$tmp" "$TARGET_ENV"

# normalize DATABASE_URL host for container networking
DB_URL="$(grep -E '^DATABASE_URL=' "$TARGET_ENV" | tail -n1 | cut -d= -f2- || true)"
if [ -n "${DB_URL:-}" ]; then
  DB_URL="${DB_URL//@localhost:/@host.docker.internal:}"
  DB_URL="${DB_URL//@127.0.0.1:/@host.docker.internal:}"
  grep -v '^DATABASE_URL=' "$TARGET_ENV" > "${TARGET_ENV}.new" || true
  printf 'DATABASE_URL=%s\n' "$DB_URL" >> "${TARGET_ENV}.new"
  mv "${TARGET_ENV}.new" "$TARGET_ENV"
fi

# required keys for your backend startup
REQ_KEYS="DATABASE_URL S3_BUCKET_NAME"
for k in $REQ_KEYS; do
  if ! grep -q "^${k}=" "$TARGET_ENV"; then
    echo "ERROR: ${k} missing in $TARGET_ENV"
    exit 1
  fi
  if grep -q "^${k}=$" "$TARGET_ENV"; then
    echo "ERROR: ${k} is empty in $TARGET_ENV"
    exit 1
  fi
done

echo "Merged external env into $TARGET_ENV from $EXT_ENV"
