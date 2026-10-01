#!/bin/sh
set -eu

echo "[entrypoint] starting..."

# Provision Fleet OAuth credentials from the environment.
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  apra-fleet auth --oauth "$CLAUDE_CODE_OAUTH_TOKEN" 2>/dev/null || true
fi

# The published @apralabs/apra-fleet has a broken file: dependency and
# Docker Desktop on Windows can lose directories across overlay layers.
# Always copy from the working global install to guarantee it exists.
mkdir -p node_modules/@apralabs
rm -rf node_modules/@apralabs/apra-fleet
cp -a "$(npm root -g)/@apralabs/apra-fleet" node_modules/@apralabs/apra-fleet
if [ -d node_modules/@apralabs/apra-fleet ]; then
  echo "[entrypoint] @apralabs/apra-fleet ready"
else
  echo "[entrypoint] WARNING: @apralabs/apra-fleet copy failed!"
fi

echo "[entrypoint] exec: $*"
exec "$@"
