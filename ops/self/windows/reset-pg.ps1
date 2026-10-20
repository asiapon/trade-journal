# =============================================================================
#  ops/self/windows/reset-pg.ps1 -- 重置 PostgreSQL postgres 超级用户密码（救援）
# -----------------------------------------------------------------------------
#  适用：winget/EDB 静默安装后不知道 postgres 密码，导致 install 连不上库。
#  用法（管理员 PowerShell）：
#    powershell -ExecutionPolicy Bypass -File .\reset-pg.ps1 -NewPassword "新密码"
#    （或双击 reset-pg.bat，会提示输入）
#  原理：临时把 pg_hba.conf 本机认证改为 trust → ALTER USER 重设 → 恢复配置并重启。
#        全程自动备份 pg_hba.conf（pg_hba.conf.bak-reset）。
# =============================================================================
param([string]$NewPassword = "")
. (Join-Path $PSScriptRoot "_common.ps1")

$ErrorActionPreference = "Stop"
Write-Title "救援 · 重置 postgres 密码"

if (-not (Test-Admin)) { Stop-WithError "请用管理员身份运行 PowerShell" }
if (-not $NewPassword) {
  $secure = Read-Host "  输入 postgres 的新密码" -AsSecureString
  $NewPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}
if (-not $NewPassword) { Stop-WithError "密码不能为空" }

# ---------- 1. 定位服务与数据目录 ----------
Write-Step "定位 PostgreSQL"
$svc = Get-CimInstance Win32_Service | Where-Object { $_.Name -like 'postgresql*' } | Select-Object -First 1
if (-not $svc) { Stop-WithError "未找到 PostgreSQL 服务（没装？）" }
Write-Info2 "服务：$($svc.Name)（$($svc.State)）"

if ($svc.PathName -match '-D\s+"([^"]+)"') { $dataDir = $Matches[1] }
elseif ($svc.PathName -match '-D\s+(\S+)') { $dataDir = $Matches[1] }
else { Stop-WithError "无法从服务路径解析数据目录：$($svc.PathName)" }
Write-Info2 "数据目录：$dataDir"

$hba = Join-Path $dataDir "pg_hba.conf"
if (-not (Test-Path $hba)) { Stop-WithError "找不到 $hba" }
$binDir = Split-Path -Parent $svc.PathName.Replace('"', '').Split('-')[0].Trim()

# ---------- 2. 停服务 → 临时 trust ----------
Write-Step "临时开启 trust 认证"
Stop-Service $svc.Name -Force
Copy-Item $hba "$hba.bak-reset" -Force
Write-Info2 "已备份 pg_hba.conf → pg_hba.conf.bak-reset"

$lines = Get-Content $hba | ForEach-Object {
  if ($_ -match '^\s*host\s' -and $_ -match '\b(scram-sha-256|md5)\b') {
    ($_ -replace '\b(scram-sha-256|md5)\b', 'trust')
  } else { $_ }
}
Set-Content -Path $hba -Value $lines -Encoding ASCII
Start-Service $svc.Name
Start-Sleep -Seconds 2
Write-Ok "已切到 trust 并启动服务"

# ---------- 3. 重设密码 ----------
Write-Step "重设密码"
$psql = Join-Path $binDir "psql.exe"
if (-not (Test-Path $psql)) { $psql = "psql" }
& $psql -U postgres -h 127.0.0.1 -c "ALTER USER postgres PASSWORD '$NewPassword';"
if ($LASTEXITCODE -ne 0) {
  # 失败也要把 pg_hba 恢复回去，别把用户晾在 trust 状态
  Copy-Item "$hba.bak-reset" $hba -Force
  Restart-Service $svc.Name -Force
  Stop-WithError "ALTER USER 失败（pg_hba.conf 已恢复原样）"
}
Write-Ok "密码已修改"

# ---------- 4. 恢复认证配置 ----------
Write-Step "恢复认证配置"
Copy-Item "$hba.bak-reset" $hba -Force
Restart-Service $svc.Name -Force
Start-Sleep -Seconds 2
Write-Ok "pg_hba.conf 已恢复，服务已重启"

# ---------- 5. 验证 ----------
Write-Step "验证"
$old = $env:PGPASSWORD
$env:PGPASSWORD = $NewPassword
$chk = (& $psql -U postgres -h 127.0.0.1 -tAc "SELECT 'OK'::text") 2>$null
$env:PGPASSWORD = $old
if ("$chk".Trim() -eq "OK") {
  Write-Ok "新密码验证通过"
  Write-Footer @(
    "新密码：$NewPassword",
    "记好它，或直接重跑 install.bat（提示输入 postgres 密码时填这个）"
  )
} else {
  Write-Bad "重置后验证失败"
  Write-Info2 "检查 pg_hba.conf.bak-reset 与服务状态：Get-Service *postgres*"
  exit 1
}
