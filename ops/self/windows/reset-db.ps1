# =============================================================================
#  ops/self/windows/reset-db.ps1 -- 快速重置应用数据库（秒级，不卸载任何组件）
# -----------------------------------------------------------------------------
#  用法（管理员 PowerShell）：
#    powershell -ExecutionPolicy Bypass -File .\reset-db.ps1
#    powershell -ExecutionPolicy Bypass -File .\reset-db.ps1 -AdminUser admin -AdminPwd 新密码
#
#  做的事：删应用库 tradejournal → 重建空库 → 导 schema → 建管理员
#          Node / PostgreSQL / Python 全部不动。
#  反复实验请用这个，别走「卸载 PostgreSQL → 重装」（那是分钟级的）。
# =============================================================================
param(
  [string]$AdminUser = "admin",
  [string]$AdminPwd = "admin123",
  [switch]$Yes
)
. (Join-Path $PSScriptRoot "_common.ps1")

$ErrorActionPreference = "Stop"
Write-Title "快速重置应用数据库"
$DbName = "tradejournal"
$DbUser = "tradejournal"

if (-not (Test-Admin)) { Stop-WithError "请用管理员身份运行 PowerShell" }

Write-Bad "即将清空数据库 $DbName 的全部数据（交易/自选/问答/持仓），不可恢复！"
if (-not $Yes) {
  $a = Read-Host "  确认重置？(y/N)"
  if ($a -notmatch '^[Yy]') { Write-Host "  已取消"; exit 0 }
}

$psql = Find-Psql
if (-not $psql) { Stop-WithError "找不到 psql.exe（PostgreSQL 未安装）" }

# 从 .env 读角色密码，避免再问一次
$DbPassword = $null
$dbUrl = Get-DbUrl
if ($dbUrl -and $dbUrl -match '://[^:]+:([^@]+)@') { $DbPassword = $Matches[1] }

$secure = Read-Host "  输入 postgres 超级用户密码" -AsSecureString
$pgPwd = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
$old = $env:PGPASSWORD
$env:PGPASSWORD = $pgPwd

try {
  # ---------- 1. 重建库 ----------
  Write-Step "重建数据库"
  & $psql -U postgres -h 127.0.0.1 -c "DROP DATABASE IF EXISTS $DbName;" 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Stop-WithError "删库失败（有活动连接？先 .\stop.bat）" }

  $roleOk = (& $psql -U postgres -h 127.0.0.1 -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DbUser'") 2>$null
  if ("$roleOk".Trim() -ne "1") {
    if (-not $DbPassword) { Stop-WithError "角色不存在且 .env 里没密码，先跑 install.bat" }
    & $psql -U postgres -h 127.0.0.1 -c "CREATE ROLE $DbUser LOGIN PASSWORD '$DbPassword';" 2>&1 | Out-Null
  } elseif ($DbPassword) {
    # 角色在但密码可能和 .env 对不上 → 同步
    & $psql -U postgres -h 127.0.0.1 -c "ALTER ROLE $DbUser WITH LOGIN PASSWORD '$DbPassword';" 2>&1 | Out-Null
  }
  & $psql -U postgres -h 127.0.0.1 -c "CREATE DATABASE $DbName OWNER $DbUser;" 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Stop-WithError "建库失败" }
  Write-Ok "库已重建"

  # ---------- 2. 导 schema ----------
  Write-Step "导入 schema"
  $schema = Join-Path $DeployDir "schema.sql"
  if (-not (Test-Path $schema)) { Stop-WithError "找不到 $schema" }
  & $psql -U postgres -h 127.0.0.1 -d $DbName -v ON_ERROR_STOP=1 -f $schema 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Warn2 "schema 执行有告警（重复对象属正常）" } else { Write-Ok "schema 已导入" }

  # ---------- 3. 建管理员 ----------
  Write-Step "创建管理员"
  $au = $AdminUser.Replace("'", "''")
  $ap = $AdminPwd.Replace("'", "''")
  $r = & $psql -U postgres -h 127.0.0.1 -d $DbName -tAc "SELECT public.app_setup_admin('$au', '$ap');" 2>$null
  if ("$r" -match '"ok"\s*:\s*true') { Write-Ok "管理员 $AdminUser 已创建" }
  else { Write-Warn2 "创建返回：$r（可打开网页用「首次初始化」创建）" }
} finally {
  $env:PGPASSWORD = $old
}

$Port = Get-SelfPort
Write-Footer @(
  "重置完成：库 $DbName 重建 + schema 同步 + 管理员 $AdminUser / $AdminPwd",
  "重启服务： .\restart.bat",
  "然后打开 http://localhost:$Port 用上述账号登录"
)
