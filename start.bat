@echo off
chcp 65001 > nul
title Upbit Auto Coin Trade - Launcher

echo ========================================================
echo   Upbit 다중 전략 코인 자동매매 시스템 시작 (Start)
echo ========================================================

cd /d "%~dp0"

echo [1/2] Python FastAPI 백엔드 서버 실행 중 (Port: 8000)...
start "AutoCoinTrade-Backend" cmd /k "python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload"

echo [2/2] React 프론트엔드 로컬 웹 서버 실행 중 (Port: 9000)...
cd /d "%~dp0frontend"
start "AutoCoinTrade-Frontend" cmd /k "npm run dev"

echo.
echo 실행이 요청되었습니다!
echo - 프론트엔드 웹 화면: http://localhost:9000
echo - 백엔드 API 문서  : http://127.0.0.1:8000/docs
echo - 입장 코드        : sws@2129
echo ========================================================
pause

