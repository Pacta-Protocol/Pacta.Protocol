#!/usr/bin/env bash
# One-shot runner: install dependencies (first time) and start the marketplace.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi

exec npm start
