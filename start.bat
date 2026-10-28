@echo off
setlocal
chcp 65001 > nul
title Upbit Auto Coin Trade - Background Launcher

set "ROOT_DIR=%~dp0"
if "%ROOT_DIR:~-1%"=="\" set "ROOT_DIR=%ROOT_DIR:~0,-1%"
set "FRONTEND_DIR=%ROOT_DIR%\frontend"
set "PATH=D:\dev\tools\nodejs;%ROOT_DIR%\.venv\Scripts;%LOCALAPPDATA%\Programs\Python\Python313;%LOCALAPPDATA%\Programs\Python\Python313\Scripts;%LOCALAPPDATA%\Programs\Python\Python312;%LOCALAPPDATA%\Programs\Python\Python312\Scripts;%LOCALAPPDATA%\Programs\Python\Python311;%LOCALAPPDATA%\Programs\Python\Python311\Scripts;%PATH%"

if not exist "%ROOT_DIR%\logs" mkdir "%ROOT_DIR%\logs"

echo ========================================================
echo   Upbit Auto Coin Trade - Background Start
echo ========================================================

if not exist "%FRONTEND_DIR%\node_modules\vite" (
    echo [Setup] Installing frontend packages...
    pushd "%FRONTEND_DIR%"
    call npm.cmd install
    popd
)

python -c "import sys" >nul 2>nul
if %ERRORLEVEL% NEQ 0 goto :NO_PYTHON

python -c "import fastapi, uvicorn" >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [Setup] Installing backend packages...
    python -m pip install -r "%ROOT_DIR%\backend\requirements.txt"
)

echo [1/2] Starting FastAPI Backend in background [Port: 8001]...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c python -m uvicorn backend.main:app --host 127.0.0.1 --port 8001 > logs\backend.log 2>&1' -WorkingDirectory $env:ROOT_DIR -WindowStyle Hidden"
goto :START_FRONTEND

:NO_PYTHON
echo [1/2] Starting SQLite Backend in background [Port: 8001]...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath 'D:\dev\tools\nodejs\node.exe' -ArgumentList 'backend\node_server.mjs' -WorkingDirectory $env:ROOT_DIR -RedirectStandardOutput '$env:ROOT_DIR\logs\backend.log' -RedirectStandardError '$env:ROOT_DIR\logs\backend_err.log' -WindowStyle Hidden"

:START_FRONTEND
echo [2/2] Starting React Frontend in background [Port: 9000]...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath 'D:\dev\tools\nodejs\npm.cmd' -ArgumentList 'run dev' -WorkingDirectory $env:FRONTEND_DIR -RedirectStandardOutput '$env:ROOT_DIR\logs\frontend.log' -RedirectStandardError '$env:ROOT_DIR\logs\frontend_err.log' -WindowStyle Hidden"

echo.
echo Background startup triggered successfully!
echo - Frontend URL : http://localhost:9000
echo - Backend Docs : http://127.0.0.1:8001/docs
echo - Entry Code   : sws@2129
echo - Log Files    : logs\backend.log, logs\frontend.log
echo - How to Stop  : Run stop.bat
echo ========================================================
ping 127.0.0.1 -n 3 > nul
endlocal
