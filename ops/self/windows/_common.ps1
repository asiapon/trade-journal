# =============================================================================
#  ops/self/windows/_common.ps1 -- Windows 自托管脚本共用
# -----------------------------------------------------------------------------
#  由同目录下各 .ps1 用 . (dot-source) 引入，不单独执行。
#  注意：本文件保持 PowerShell 5.1 兼容 —— 不用 && / || / ?? / 三元运算符。
# =============================================================================

# 控制台切 UTF-8：psql / node / npm 的中文输出不乱码
try {
  chcp 65001 > $null
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $env:PGCLIENTENCODING = 'UTF8'
} catch { }

# ---------- 路径：ops/self/windows/ -> 上溯三级到仓库根 ----------
$SelfDir = $PSScriptRoot
$RepoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $SelfDir))
$DeployDir = Join-Path $RepoRoot "deploy\selfhost"
$EnvFile = Join-Path $DeployDir ".env"
$ServerJs = Join-Path $DeployDir "server.js"
$PacksDir = Join-Path $DeployDir "packs"
$LogsDir = Join-Path $DeployDir "logs"
$BackupDir = Join-Path $RepoRoot "backups"

# ---------- 端口 ----------
function Get-SelfPort {
  $p = 3000
  if (Test-Path $EnvFile) {
    Get-Content $EnvFile | ForEach-Object {
      if ($_ -match '^\s*PORT\s*=\s*(\d+)\s*$') { $p = [int]$Matches[1] }
    }
  }
  return $p
}

# ---------- 输出 ----------
function Write-Title([string]$t) {
  Write-Host ""
  Write-Host $t -ForegroundColor Cyan
  Write-Host ("-" * 50) -ForegroundColor DarkGray
}
function Write-Step([string]$t) { Write-Host ""; Write-Host "> $t" -ForegroundColor Cyan }
function Write-Ok([string]$t) { Write-Host "  [OK] $t" -ForegroundColor Green }
function Write-Warn2([string]$t) { Write-Host "  [!] $t" -ForegroundColor Yellow }
function Write-Bad([string]$t) { Write-Host "  [X] $t" -ForegroundColor Red }
function Write-Info2([string]$t) { Write-Host "  . $t" -ForegroundColor DarkGray }
function Write-Footer([string[]]$lines) {
  Write-Host ""
  Write-Host ("-" * 50) -ForegroundColor DarkGray
  foreach ($l in $lines) { Write-Host "  $l" }
  Write-Host ("-" * 50) -ForegroundColor DarkGray
}
function Stop-WithError([string]$msg) {
  Write-Host ""
  Write-Host "  [X] $msg" -ForegroundColor Red
  exit 1
}

# ---------- 权限 ----------
function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $pr = New-Object Security.Principal.WindowsPrincipal($id)
  return $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
function Assert-Deployed {
  if (-not (Test-Path $ServerJs)) {
    Stop-WithError "找不到后端服务：$ServerJs（仓库不完整？）"
  }
}

# ---------- 进程 ----------
# 按端口找监听进程，返回 PID 数组（找不到返回空数组）
function Get-ListenerPids([int]$port) {
  $pids = @()
  try {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
      if ($_.OwningProcess) { $pids += [int]$_.OwningProcess }
    }
  } catch { }
  return ($pids | Select-Object -Unique)
}

# 健康检查（最多等 N 秒）
function Wait-Health([int]$port, [int]$seconds = 15) {
  for ($i = 0; $i -lt $seconds; $i++) {
    Start-Sleep -Seconds 1
    try {
      $r = Invoke-RestMethod "http://127.0.0.1:$port/healthz" -TimeoutSec 2 -ErrorAction Stop
      if ($r.ok) { return $true }
    } catch { }
  }
  return $false
}

# 找 psql.exe：卸载器会删程序但留空目录，必须真的找到 exe
function Find-Psql {
  if (Test-Path "C:\Program Files\PostgreSQL") {
    foreach ($d in (Get-ChildItem "C:\Program Files\PostgreSQL" | Sort-Object Name -Descending)) {
      $p = Join-Path $d.FullName "bin\psql.exe"
      if (Test-Path $p) { return $p }
    }
  }
  $cmd = Get-Command psql -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

# 从 .env 读 DATABASE_URL
function Get-DbUrl {
  if (-not (Test-Path $EnvFile)) { return "" }
  $v = ""
  Get-Content $EnvFile | ForEach-Object {
    if ($_ -match '^\s*DATABASE_URL\s*=\s*(.+)$') { $v = $Matches[1].Trim() }
  }
  return $v
}

# 隐去连接串里的密码
function Hide-DbPassword([string]$url) {
  if (-not $url) { return "" }
  return [regex]::Replace($url, '(://[^:]+:)[^@]+@', '$1***@')
}
