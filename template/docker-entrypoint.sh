#!/bin/sh
set -eu

# Provision Fleet OAuth credentials from the environment.
# This is the Docker equivalent of running `claude login` locally.
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  apra-fleet auth --oauth "$CLAUDE_CODE_OAUTH_TOKEN" 2>/dev/null || true
fi

# The published @apralabs/apra-fleet has an internal file: dependency that npm
# hoists incorrectly — the parent package is missing from local node_modules.
# Copy the working global install at startup so workflow imports resolve.
if [ ! -d node_modules/@apralabs/apra-fleet ]; then
  mkdir -p node_modules/@apralabs
  cp -a "$(npm root -g)/@apralabs/apra-fleet" node_modules/@apralabs/apra-fleet
fi

exec "$@"
