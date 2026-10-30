#!/usr/bin/env bash
# Upbit AutoCoinTrade - Backend Runner (Linux)
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"
mkdir -p logs data

# PATH에 사용자 로컬 bin 경로 추가
export PATH="$HOME/.local/bin:$HOME/bin:$PATH"

NODE_BIN=$(command -v node 2>/dev/null || true)
if [ -z "$NODE_BIN" ]; then
    echo "[ERROR] node 명령어를 찾을 수 없습니다." >&2
    exit 1
fi

echo "[Backend] Starting Node.js SQLite server on port 8001..."
exec "$NODE_BIN" backend/node_server.mjs
