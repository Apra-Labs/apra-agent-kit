#!/bin/sh
set -eu

# Provision Fleet OAuth credentials from the environment.
# This is the Docker equivalent of running `claude login` locally.
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  apra-fleet auth --oauth "$CLAUDE_CODE_OAUTH_TOKEN" 2>/dev/null || true
fi

exec "$@"
