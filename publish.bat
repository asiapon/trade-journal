@echo off
chcp 65001 >nul 2>nul
setlocal EnableDelayedExpansion
REM ============================================================================
REM  Trade Journal - one-click publish (Windows)
REM  All user-facing Chinese text is printed by node/scripts/publish.mjs,
REM  so this file stays pure ASCII: no code-page / garbled-text problems.
REM ----------------------------------------------------------------------------
REM  Double-click              -> interactive menu
REM  publish.bat check         -> build + test + artifact verify only
REM  publish.bat cf            -> deploy to Cloudflare Workers + D1
REM  publish.bat local         -> build + start local preview
REM  publish.bat wb            -> build + sync to WorkBuddy staging dir
REM  publish.bat self          -> scp to self-hosted server
REM  publish.bat dev           -> vite dev server (hot reload)
REM  publish.bat cf-bootstrap  -> first time: create D1 + apply schema
REM  publish.bat cf-delete     -> delete Worker + D1 (DATA LOSS)
REM  publish.bat env           -> create .env.local template for credentials
REM
REM  Append --no-pause for CI / other scripts: publish.bat check --no-pause
REM  Credentials file: .env.local in this folder (git-ignored)
REM ============================================================================

cd /d "%~dp0"

REM ---------- 0. Node must exist ----------
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [X] node not found. Install Node.js 18+ from https://nodejs.org/
  echo       then reopen the terminal and run this script again.
  echo.
  if not "%~1"=="--no-pause" pause
  exit /b 1
)

REM ---------- 1. Parse --no-pause (in any position) ----------
set "NOPAUSE="
set "CMD=%~1"
if /i "%~1"=="--no-pause" (
  set "NOPAUSE=1"
  set "CMD=%~2"
)
if /i "%~2"=="--no-pause" set "NOPAUSE=1"

REM ---------- 2. Load credentials from .env.local ----------
REM KEY=VALUE lines, # starts a comment. Existing env vars win (not overwritten).
if exist ".env.local" (
  for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env.local") do (
    set "_k=%%a"
    set "_v=%%b"
    for /f "tokens=* delims= " %%x in ("!_k!") do set "_k=%%x"
    if not "!_k!"=="" (
      if not defined !_k! set "!_k!=!_v!"
    )
  )
)

REM ---------- 3. Dependencies ----------
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

REM ---------- 4. Choose command ----------
if not defined CMD (
  echo.
  echo   ============================================
  echo     Trade Journal - Publish Tool
  echo   ============================================
  echo.
  echo     [1] check       build + test + verify (no deploy)
  echo     [2] cf          deploy to Cloudflare Workers + D1
  echo     [3] local       build + local preview
  echo     [4] wb          build + sync to WorkBuddy staging
  echo     [5] self        sync to self-hosted server
  echo     [6] dev         vite dev server (hot reload)
  echo     [7] cf-bootstrap  first time: create D1 + schema
  echo     [8] env         create .env.local template
  echo     [0] exit
  echo.
  set /p "SEL=  Enter number: "
  if "!SEL!"=="1" set "CMD=check"
  if "!SEL!"=="2" set "CMD=cf"
  if "!SEL!"=="3" set "CMD=local"
  if "!SEL!"=="4" set "CMD=wb"
  if "!SEL!"=="5" set "CMD=self"
  if "!SEL!"=="6" set "CMD=dev"
  if "!SEL!"=="7" set "CMD=cf-bootstrap"
  if "!SEL!"=="8" set "CMD=env"
  if "!SEL!"=="0" exit /b 0
  if not defined CMD (
    echo.
    echo   [X] Invalid choice.
    if not defined NOPAUSE pause
    exit /b 1
  )
)

REM ---------- 5. Dispatch ----------
echo.
echo   ^>^> running: %CMD%
echo.

if /i "%CMD%"=="dev" (
  call npm run dev
  goto done
)
if /i "%CMD%"=="cf-bootstrap" (
  call node scripts\cloudflare.mjs bootstrap
  goto done
)
if /i "%CMD%"=="cf-delete" (
  call node scripts\cloudflare.mjs delete
  goto done
)
if /i "%CMD%"=="env" goto makeenv

REM check / cf / local / wb / self all go through publish.mjs
call node scripts\publish.mjs %CMD%
goto done

REM ---------- make .env.local ----------
:makeenv
if exist ".env.local" (
  echo   [!] .env.local already exists, not overwriting. Current content:
  echo.
  type .env.local
  goto done
)
>  ".env.local" echo # Publish credentials - this file is git-ignored and never committed
>> ".env.local" echo # Fill in and run:  publish.bat cf
>> ".env.local" echo.
>> ".env.local" echo # Cloudflare: dash.cloudflare.com -^> My Profile -^> API Tokens
>> ".env.local" echo # Needs at least: Workers Scripts:Edit + D1:Edit
>> ".env.local" echo CLOUDFLARE_API_TOKEN=
>> ".env.local" echo.
>> ".env.local" echo # Account ID: Cloudflare dashboard -^> Workers overview -^> bottom right
>> ".env.local" echo CLOUDFLARE_ACCOUNT_ID=
>> ".env.local" echo.
>> ".env.local" echo # Self-hosted target (user@host form), leave empty if unused
>> ".env.local" echo SELF_HOST=
>> ".env.local" echo SELF_PATH=/opt/stockjournal/dist
echo   [OK] .env.local created. Edit it with:  notepad .env.local
goto done

:done
echo.
if defined NOPAUSE (
  endlocal
  exit /b 0
)
echo   --------------------------------------------
echo    Done. Press any key to close this window.
echo   --------------------------------------------
pause >nul
endlocal
