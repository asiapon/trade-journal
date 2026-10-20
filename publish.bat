@echo off
chcp 65001 >nul 2>nul
setlocal EnableDelayedExpansion
REM ============================================================================
REM  publish.bat -- top-level entry (Windows)
REM ----------------------------------------------------------------------------
REM  This layer only: checks node, shows a menu, forwards to ops\cli.mjs.
REM  All real logic lives in ops\  (see ops\README.md).
REM
REM  Usage:
REM    publish.bat                  interactive menu
REM    publish.bat check            build + verify + test
REM    publish.bat cf               deploy to Cloudflare
REM    publish.bat cf status        Cloudflare status
REM    publish.bat self install     install self-hosted service
REM    publish.bat wb sync          sync WorkBuddy publish dir
REM    publish.bat help             full command list
REM
REM  Append --no-pause to skip the final keypress (for CI / other scripts).
REM  Credentials: .env.local in this folder (git-ignored).
REM ============================================================================

cd /d "%~dp0"

REM ---------- 0. node ----------
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [X] node not found. Install Node.js 18+ from https://nodejs.org/
  echo       then reopen the terminal.
  echo.
  if not "%~1"=="--no-pause" pause
  exit /b 1
)

REM ---------- 1. parse --no-pause ----------
set "NOPAUSE="
set "ARGS=%*"
if not "%ARGS%"=="" (
  echo %ARGS% | findstr /i /c:"--no-pause" >nul 2>nul
  if not errorlevel 1 (
    set "NOPAUSE=1"
    set "ARGS=!ARGS:--no-pause=!"
  )
)

REM ---------- 2. dependencies ----------
if not exist "node_modules\" (
  echo.
  echo   [!] node_modules missing, running npm install ...
  call npm install
  if errorlevel 1 (
    echo   [X] npm install failed
    if not defined NOPAUSE pause
    exit /b 1
  )
)

REM ---------- 3. menu when no args ----------
if not "%ARGS%"=="" goto dispatch

echo.
echo   ============================================
echo     Trade Journal - Publish and Ops
echo   ============================================
echo.
echo     [1] check            build + verify + test (no deploy)
echo     [2] cf deploy        deploy to Cloudflare Workers + D1
echo     [3] cf status        Worker / D1 / row counts
echo     [4] local preview    build + preview at :4173
echo     [5] wb sync          build + copy to WorkBuddy dir
echo     [6] self install     install/upgrade server service
echo     [7] self start/stop  start, stop, restart
echo     [8] self status/logs show status or logs
echo     [9] self backup      backup or restore
echo    [10] self uninstall   uninstall (asks per item)
echo    [11] dev serve        hot reload at :5173
echo    [12] dev env          create .env.local template
echo     [h] help             full command list
echo     [0] exit
echo.
set /p "SEL=  Enter number: "

if "!SEL!"=="1"  set "ARGS=dev check"
if "!SEL!"=="2"  set "ARGS=cf deploy"
if "!SEL!"=="3"  set "ARGS=cf status"
if "!SEL!"=="4"  set "ARGS=dev preview"
if "!SEL!"=="5"  set "ARGS=wb sync"
if "!SEL!"=="6"  set "ARGS=self install"
if "!SEL!"=="10" set "ARGS=self uninstall"
if "!SEL!"=="11" set "ARGS=dev serve"
if "!SEL!"=="12" set "ARGS=dev env"
if /i "!SEL!"=="h" set "ARGS=help"
if "!SEL!"=="0" exit /b 0

if "!SEL!"=="7" (
  set /p "A=  start(1) / stop(2) / restart(3): "
  if "!A!"=="1" set "ARGS=self start"
  if "!A!"=="2" set "ARGS=self stop"
  if "!A!"=="3" set "ARGS=self restart"
)
if "!SEL!"=="8" (
  set /p "A=  status(1) / logs(2): "
  if "!A!"=="1" set "ARGS=self status"
  if "!A!"=="2" set "ARGS=self logs"
)
if "!SEL!"=="9" (
  set /p "A=  backup(1) / restore(2): "
  if "!A!"=="1" set "ARGS=self backup"
  if "!A!"=="2" set "ARGS=self restore"
)

if "%ARGS%"=="" (
  echo.
  echo   [X] Invalid choice.
  if not defined NOPAUSE pause
  exit /b 1
)

REM ---------- 4. forward to cli ----------
:dispatch
echo.
echo   ^>^> node ops\cli.mjs %ARGS%
echo.
call node ops\cli.mjs %ARGS%
set "RC=%ERRORLEVEL%"

echo.
if defined NOPAUSE (
  endlocal
  exit /b %RC%
)
echo   --------------------------------------------
echo    Exit code: %RC%. Press any key to close.
echo   --------------------------------------------
pause >nul
endlocal
exit /b %RC%
