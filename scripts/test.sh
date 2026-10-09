#!/usr/bin/env bash
# Run the plugin's mock test suite inside the official OpenClaw image.
# OpenClaw is never installed on the host (host Node may be older than required).
set -euo pipefail

cd "$(dirname "$0")/.."

COMMAND="${1:-test}"

case "$COMMAND" in
  test)
    docker compose run --rm --no-deps -w /plugin --entrypoint sh openclaw-gateway -lc '
      set -e
      node -v
      npm install --no-audit --no-fund --loglevel=error
      npm run typecheck
      npm test
    '
    ;;
  shell)
    docker compose run --rm --no-deps -w /plugin --entrypoint sh openclaw-gateway
    ;;
  image)
    docker compose pull openclaw-gateway
    ;;
  *)
    echo "usage: $0 [test|shell|image]" >&2
    exit 2
    ;;
esac
