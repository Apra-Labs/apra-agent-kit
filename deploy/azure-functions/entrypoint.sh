#!/bin/bash
# Provision Fleet OAuth credentials from the environment before the
# Functions host starts. This is the Docker equivalent of `claude login`.
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  apra-fleet auth --oauth "$CLAUDE_CODE_OAUTH_TOKEN" 2>/dev/null || true
fi

exec "$@"
