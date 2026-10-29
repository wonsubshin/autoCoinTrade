@echo off
chcp 65001 >nul
setlocal

echo ===================================================
echo [Upbit AutoTrade] 서비스 중지 중... (Port 8001, 5173)
echo ===================================================

for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8001 ^| findstr LISTENING') do (
    echo Port 8001 프로세스 종료 (PID: %%a)...
    taskkill /F /PID %%a >nul 2>&1
)

for /f "tokens=5" %%a in ('netstat -aon ^| findstr :5173 ^| findstr LISTENING') do (
    echo Port 5173 프로세스 종료 (PID: %%a)...
    taskkill /F /PID %%a >nul 2>&1
)

echo ===================================================
echo [완료] 백엔드 및 프론트엔드 서비스가 중지되었습니다.
echo ===================================================
pause
