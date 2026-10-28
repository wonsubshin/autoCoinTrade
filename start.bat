@echo off
chcp 65001 > nul
title Upbit Auto Coin Trade - Background Launcher

echo ========================================================
echo   Upbit 다중 전략 코인 자동매매 시스템 백그라운드 시작
echo ========================================================

cd /d "%~dp0"
if not exist "%~dp0logs" mkdir "%~dp0logs"

echo [1/2] Python FastAPI 백엔드 서버를 백그라운드로 실행 중 (Port: 8000)...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c title AutoCoinTrade-Backend && python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 >> ""%~dp0logs\backend.log"" 2>&1' -WorkingDirectory '%~dp0' -WindowStyle Hidden"

echo [2/2] React 프론트엔드 로컬 웹 서버를 백그라운드로 실행 중 (Port: 9000)...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c title AutoCoinTrade-Frontend && npm run dev >> ""%~dp0logs\frontend.log"" 2>&1' -WorkingDirectory '%~dp0frontend' -WindowStyle Hidden"

echo.
echo 백그라운드 실행이 완료되었습니다! (이 창을 닫아도 계속 실행됩니다)
echo - 프론트엔드 웹 화면: http://localhost:9000
echo - 백엔드 API 문서  : http://127.0.0.1:8000/docs
echo - 입장 코드        : sws@2129
echo - 실행 로그 위치   : logs\backend.log, logs\frontend.log
echo - 종료 방법        : stop.bat 실행
echo ========================================================
timeout /t 3 > nul


