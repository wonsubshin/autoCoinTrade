#!/usr/bin/env bash
# ===================================================
# Upbit AutoCoinTrade - Cloudflare Public Tunnel Launcher
# ===================================================
set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"
mkdir -p logs

export PATH="$HOME/.local/bin:$HOME/bin:$PATH"

if ! command -v cloudflared >/dev/null 2>&1; then
    echo "[ERROR] cloudflared가 설치되어 있지 않습니다." >&2
    exit 1
fi

# 기존 터널 종료
"$PROJECT_ROOT/stop_tunnel.sh" >/dev/null 2>&1 || true

echo "==================================================="
echo "[Upbit AutoCoinTrade] 외부 인터넷 접속 보안 터널 시작 중..."
echo "==================================================="

LOG_FILE="$PROJECT_ROOT/logs/tunnel.log"
rm -f "$LOG_FILE"

setsid cloudflared tunnel --url http://localhost:9000 </dev/null >> "$LOG_FILE" 2>&1 &
TUNNEL_PID=$!
echo "$TUNNEL_PID" > "$PROJECT_ROOT/logs/.tunnel.pid"

echo "공개 HTTPS 주소 발급 대기 중..."
PUBLIC_URL=""
for i in {1..20}; do
    if [ -f "$LOG_FILE" ]; then
        PUBLIC_URL=$(grep -oE "https://[a-zA-Z0-9-]+\.trycloudflare\.com" "$LOG_FILE" | head -n 1 || true)
        if [ -n "$PUBLIC_URL" ]; then
            break
        fi
    fi
    sleep 1
done

echo ""
echo "==================================================="
if [ -n "$PUBLIC_URL" ]; then
    echo "[SUCCESS] 외부 어디서나 접속 가능한 보안 주소가 생성되었습니다!"
    echo "==================================================="
    echo "• 외부 접속 HTTPS 주소 : $PUBLIC_URL"
    echo "• 입장 코드            : sws@2129"
    echo "• 터널 중지 명령어     : ./stop_tunnel.sh"
    echo "• 터널 로그 확인       : tail -f logs/tunnel.log"
else
    echo "[WARN] 공개 주소 파싱 중입니다. 잠시 후 logs/tunnel.log를 확인하세요:"
    echo "tail -n 20 logs/tunnel.log"
fi
echo "==================================================="
echo ""
