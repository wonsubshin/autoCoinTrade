#!/usr/bin/env bash
# ===================================================
# Upbit AutoCoinTrade - Cloudflare Public Tunnel Stopper
# ===================================================
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

echo "==================================================="
echo "[Upbit AutoCoinTrade] 외부 접속 보안 터널 중지 중..."
echo "==================================================="

PID_FILE="$PROJECT_ROOT/logs/.tunnel.pid"
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE" 2>/dev/null || true)
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
        echo "터널 프로세스 종료 [PID: $PID]..."
        kill "$PID" 2>/dev/null || true
        sleep 0.5
        if kill -0 "$PID" 2>/dev/null; then
            kill -9 "$PID" 2>/dev/null || true
        fi
    fi
    rm -f "$PID_FILE"
fi

# pkill fallback
pkill -f "cloudflared tunnel" >/dev/null 2>&1 || true

echo "==================================================="
echo "[완료] 외부 접속 터널이 안전하게 종료되었습니다."
echo "==================================================="
