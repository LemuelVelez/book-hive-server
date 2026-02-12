#!/usr/bin/env sh
set -eu

has_script() {
  node -e "const s=require('/app/package.json').scripts||{};process.exit(s[process.argv[1]]?0:1)" "$1"
}

pick_entry() {
  node -e "const fs=require('fs');const p=require('/app/package.json');const c=[p.main,'dist/index.js','dist/server.js','dist/src/index.js','dist/src/server.js','build/index.js','build/server.js'].filter(Boolean);for(const f of c){const full='/app/'+String(f).replace(/^\.\//,'');if(fs.existsSync(full)){console.log(full);process.exit(0)}}process.exit(1)"
}

ENTRY="$(pick_entry || true)"
if [ -n "${ENTRY:-}" ]; then
  echo "Starting with node ${ENTRY}"
  exec node "${ENTRY}"
fi

if has_script start:prod; then
  echo "Starting with npm run start:prod"
  exec npm run start:prod
fi

if has_script start; then
  echo "Starting with npm run start"
  exec npm run start
fi

echo "No runnable entrypoint found."
echo "Available scripts:"
npm run || true
echo "dist/build tree:"
ls -la /app || true
ls -la /app/dist || true
ls -la /app/build || true
exit 1
