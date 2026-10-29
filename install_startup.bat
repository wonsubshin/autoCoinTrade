@echo off
chcp 65001 >nul
setlocal

echo ===================================================
echo [Upbit AutoTrade] 윈도우 시작프로그램 자동 등록
echo ===================================================

set "PROJECT_DIR=%~dp0"
set "VBS_PATH=%PROJECT_DIR%scripts\start_silent.vbs"
set "STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "SHORTCUT_PATH=%STARTUP_FOLDER%\UpbitAutoTrade.lnk"

if not exist "%VBS_PATH%" (
    echo [오류] %VBS_PATH% 파일을 찾을 수 없습니다.
    pause
    exit /b 1
)

powershell -NoProfile -Command ^
  "$ws = New-Object -ComObject WScript.Shell; " ^
  "$s = $ws.CreateShortcut('%SHORTCUT_PATH%'); " ^
  "$s.TargetPath = 'wscript.exe'; " ^
  "$s.Arguments = '\"%VBS_PATH%\"'; " ^
  "$s.WorkingDirectory = '%PROJECT_DIR%'; " ^
  "$s.Description = 'Upbit AutoCoinTrade 자동 시작'; " ^
  "$s.Save();"

if exist "%SHORTCUT_PATH%" (
    echo.
    echo [성공] 윈도우 시작프로그램에 등록되었습니다!
    echo - 바로가기 위치: %SHORTCUT_PATH%
    echo - 동작: 윈도우 부팅 시 백엔드 및 웹 UI가 백그라운드에서 자동 실행됩니다.
    echo - 해제: uninstall_startup.bat 실행
    echo.
) else (
    echo.
    echo [오류] 등록에 실패했습니다. 관리자 권한을 확인해주세요.
    echo.
)

pause
