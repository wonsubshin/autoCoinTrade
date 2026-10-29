@echo off
chcp 65001 >nul
title Upbit AutoCoinTrade Services Launcher

cd /d "%~dp0\.."

set "NODE_EXE=D:\dev\tools\nodejs\node.exe"
if not exist "%NODE_EXE%" (
    set "NODE_EXE=node"
)

if not exist "logs" mkdir "logs"

echo [Upbit AutoTrade] 서비스 시작 중...

:: 1) 백엔드 서버 기동 (Port 8001)
echo [1/2] 백엔드 거래 엔진 (Port 8001) 시작...
start "UpbitAutoTrade-Backend" /min cmd /c ""%NODE_EXE%" backend/node_server.mjs >> logs\backend.log 2>&1"

:: 2) 프론트엔드 웹 UI 기동 (Port 5173)
echo [2/2] 프론트엔드 웹 UI (Port 5173) 시작...
start "UpbitAutoTrade-Frontend" /min cmd /c ""%NODE_EXE%" frontend/node_modules/vite/bin/vite.js frontend --port 5173 --host >> logs\frontend.log 2>&1"

echo [Upbit AutoTrade] 시작 완료 (http://localhost:5173)
