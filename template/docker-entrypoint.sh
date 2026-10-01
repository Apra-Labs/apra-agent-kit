#!/bin/sh
set -eu

echo "[entrypoint] starting..."

# Provision Fleet OAuth credentials from the environment.
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  apra-fleet auth --oauth "$CLAUDE_CODE_OAUTH_TOKEN" 2>/dev/null || true
fi

# The published @apralabs/apra-fleet has a broken file: dependency —
# npm hoists sub-packages but drops the parent. Copy from global.
if [ ! -d node_modules/@apralabs/apra-fleet ]; then
  echo "[entrypoint] @apralabs/apra-fleet missing, copying from global..."
  mkdir -p node_modules/@apralabs
  cp -a "$(npm root -g)/@apralabs/apra-fleet" node_modules/@apralabs/apra-fleet
  echo "[entrypoint] copied @apralabs/apra-fleet"
else
  echo "[entrypoint] @apralabs/apra-fleet already present"
fi

echo "[entrypoint] exec: $*"
exec "$@"
