#!/usr/bin/env bash
# Upbit AutoCoinTrade - Frontend Runner (Linux)
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

export PATH="$HOME/.local/bin:$HOME/bin:$PATH"

cd "$PROJECT_ROOT/frontend"
mkdir -p "$PROJECT_ROOT/logs"

if [ ! -d "node_modules/vite" ]; then
    echo "[Frontend] Dependencies not found. Running npm install..."
    npm install
fi

echo "[Frontend] Starting Vite Dev Server on port 9000..."
exec npx vite --port 9000 --host
