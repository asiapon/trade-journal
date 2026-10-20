@echo off
setlocal EnableDelayedExpansion
rem ============================================================
rem  Backup database and config
rem  ASCII-only shim: real logic lives in backup.ps1
rem  Append --no-pause to skip the final keypress (for scripts/CI).
rem ============================================================

chcp 65001 >nul 2>nul

set "NOPAUSE="
set "ARGS=%*"
if not "%ARGS%"=="" (
  echo %ARGS% | findstr /i /c:"--no-pause" >nul 2>nul
  if not errorlevel 1 (
    set "NOPAUSE=1"
    set "ARGS=!ARGS:--no-pause=!"
  )
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0backup.ps1" !ARGS!
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
