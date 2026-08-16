#!/bin/sh
# One-click phone access to DeepSeek Harness (macOS/Linux).
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if ! command -v node >/dev/null 2>&1; then
  echo '[ERROR] node not found in PATH. DeepSeek Harness requires Node.js.'
  exit 1
fi
node "$DIR/cli.js" start "$@"
