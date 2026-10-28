# =============================================================================
#  scripts/self/windows/install.ps1 -- 在 Windows 上安装/升级自托管服务
# -----------------------------------------------------------------------------
#  用法（管理员 PowerShell）：
#    powershell -ExecutionPolicy Bypass -File .\install.ps1
#    .\install.bat                        双击/命令行均可
#    .\install.bat -AutoStart             顺便注册开机自启（计划任务）
#    .\install.bat -DbPassword "xxx"      指定数据库角色密码
#    .\install.bat -PgSuperPassword "xxx" 指定 postgres 超管密码
#
#  幂等：重复跑是「升级」——保留数据库与 .env，只同步代码与 schema。
# =============================================================================
param(
  [string]$DbPassword = "",
  [string]$PgSuperPassword = "",
  [switch]$AutoStart
)
. (Join-Path $PSScriptRoot "_common.ps1")

$ErrorActionPreference = "Stop"

Write-Title "自托管 · 安装 / 升级（Windows）"
$Port = Get-SelfPort
$DbName = "tradejournal"
$DbUser = "tradejournal"
$isUpgrade = Test-Path $EnvFile

Write-Host "  仓库：$RepoRoot"
if ($isUpgrade) { Write-Info2 "检测到已有 .env，本次按「升级」处理（数据保留）" }

if (-not (Test-Admin)) { Stop-WithError "请用管理员身份运行 PowerShell" }

# ---------- 1. Node.js ----------
Write-Step "[1/6] Node.js"
$nodeOk = $false
try {
  $v = (& node -v) 2>$null
  if ($v -match '^v(\d+)' -and [int]$Matches[1] -ge 18) {
    $nodeOk = $true
    Write-Ok "已有 node $v"
  }
} catch { }
if (-not $nodeOk) {
  Write-Info2 "安装 Node.js LTS（winget）…"
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) { Stop-WithError "未检测到 winget。请手动安装 Node.js LTS（https://nodejs.org）后重跑" }
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements | Out-Null
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
  Write-Ok "已安装 node $(& node -v)"
}

# ---------- 2. PostgreSQL ----------
Write-Step "[2/6] PostgreSQL"
$psql = Find-Psql
if ($psql) {
  Write-Ok "已有 PostgreSQL：$psql"
} else {
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) { Stop-WithError "未检测到 winget。请手动安装 PostgreSQL（https://www.postgresql.org/download/windows/）后重跑" }
  Write-Info2 "安装 PostgreSQL 16（winget，耗时几分钟）…"
  winget install -e --id PostgreSQL.PostgreSQL.16 --accept-source-agreements --accept-package-agreements | Out-Null
  $psql = Find-Psql
  if (-not $psql) { Stop-WithError "安装后仍找不到 psql.exe，请手动安装后重跑" }
  Write-Ok "已安装：$psql"
}

# 超管密码：验证 + 最多 3 次重试
if (-not $PgSuperPassword) {
  $secure = Read-Host "  输入 postgres 超级用户密码（安装 PG 时设置的）" -AsSecureString
  $PgSuperPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}
$pwOk = $false
for ($attempt = 1; $attempt -le 3 -and -not $pwOk; $attempt++) {
  $env:PGPASSWORD = $PgSuperPassword
  $t = (& $psql -U postgres -h 127.0.0.1 -tAc "SELECT 1") 2>$null
  if ("$t".Trim() -eq "1") { $pwOk = $true; break }
  if ($attempt -lt 3) {
    Write-Warn2 "第 $attempt 次认证失败。忘记密码需重置 postgres 超管密码（见文末提示）"
    $secure = Read-Host "  重新输入 postgres 密码" -AsSecureString
    $PgSuperPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
  }
}
if (-not $pwOk) {
  Write-Bad "连续 3 次认证失败"
  Write-Info2 "重置 postgres 超管密码（需管理员，改 pg_hba.conf 为 trust 后重启服务）："
  Write-Info2 '  1) 编辑 C:\Program Files\PostgreSQL\16\data\pg_hba.conf，把 localhost 两行的 scram-sha-256 改成 trust'
  Write-Info2 '  2) Restart-Service postgresql-x64-16'
  Write-Info2 '  3) psql -U postgres -c "ALTER USER postgres WITH PASSWORD ''新密码'';"'
  Write-Info2 '  4) 把 pg_hba.conf 改回 scram-sha-256 并再次重启服务'
  exit 1
}
Write-Ok "postgres 认证通过"

# ---------- 3. 角色 / 库 / schema ----------
Write-Step "[3/6] 数据库初始化"
if (-not $DbPassword) {
  if ($isUpgrade) {
    $existing = Get-DbUrl
    if ($existing -match '://[^:]+:([^@]+)@') {
      $DbPassword = $Matches[1]
      Write-Info2 "沿用现有 .env 里的数据库密码"
    }
  }
  if (-not $DbPassword) {
    $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
    $DbPassword = -join (1..20 | ForEach-Object { $chars[(Get-Random -Maximum $chars.Length)] })
    $generatedPw = $true
  }
}

$existsRole = (& $psql -U postgres -h 127.0.0.1 -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DbUser'") 2>$null
if ("$existsRole".Trim() -ne "1") {
  & $psql -U postgres -h 127.0.0.1 -c "CREATE ROLE $DbUser LOGIN PASSWORD '$DbPassword'" | Out-Null
} else {
  # 角色已存在：同步密码，否则 .env 与角色旧密码不一致，服务连库必失败
  & $psql -U postgres -h 127.0.0.1 -c "ALTER ROLE $DbUser WITH LOGIN PASSWORD '$DbPassword'" | Out-Null
}
$existsDb = (& $psql -U postgres -h 127.0.0.1 -tAc "SELECT 1 FROM pg_database WHERE datname='$DbName'") 2>$null
if ("$existsDb".Trim() -ne "1") {
  & $psql -U postgres -h 127.0.0.1 -c "CREATE DATABASE $DbName OWNER $DbUser" | Out-Null
}
$schema = Join-Path $DeployDir "schema.sql"
if (Test-Path $schema) {
  & $psql -U postgres -h 127.0.0.1 -d $DbName -v ON_ERROR_STOP=1 -f $schema 2>&1 | Out-Null
  Write-Ok "库 $DbName 与 schema 就绪（幂等）"
} else {
  Write-Warn2 "找不到 schema.sql：$schema"
}

# 管理员：升级时保留已有账号
$adminUser = "admin"
if (-not $isUpgrade) {
  $input = Read-Host "  管理员用户名（回车 = admin）"
  if ($input) { $adminUser = $input }
  $adminPwd = ""
  for ($i = 0; $i -lt 3 -and $adminPwd.Length -lt 6; $i++) {
    if ($i -gt 0) { Write-Warn2 "密码至少 6 位，请重新输入" }
    $adminPwd = Read-Host "  管理员密码（回车 = admin123；登录后可改）"
    if (-not $adminPwd) { $adminPwd = "admin123" }
  }
  if ($adminPwd.Length -lt 6) { $adminPwd = "admin123" }
  $au = $adminUser.Replace("'", "''")
  $ap = $adminPwd.Replace("'", "''")
  $r = & $psql -U postgres -h 127.0.0.1 -d $DbName -tAc "SELECT public.app_setup_admin('$au', '$ap');"
  if ("$r" -match '"ok"\s*:\s*true') { Write-Ok "管理员 $adminUser 已创建" }
  elseif ("$r" -match '已初始化|已存在') { Write-Info2 "已有管理员，保留现有账号" }
  else { Write-Warn2 "管理员创建返回：$r（可在网页用「首次初始化」创建）" }
} else {
  Write-Info2 "升级模式：跳过管理员创建，保留现有账号"
}

# ---------- 4. 后端依赖 + .env ----------
Write-Step "[4/6] 后端依赖与配置"
$pyOk = $false
try {
  $pv = (& python --version) 2>$null
  if ($pv -match '^Python 3') { $pyOk = $true; Write-Ok "已有 $pv" }
} catch { }
if (-not $pyOk) {
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) {
    winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements | Out-Null
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
    Write-Ok "已安装 $(& python --version)"
  } else {
    Write-Warn2 "未装 Python 且无 winget —— SKILL.md 技能包不可用，其余功能不受影响"
  }
}
# pip 往 stderr 写进度会被 EAP=Stop 当成终止错误，这里局部降级
$eapSaved = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& python -m pip install --quiet requests pandas stockstats mootdx baostock xlrd openpyxl 2>&1 | Out-Null
$ErrorActionPreference = $eapSaved
if ($LASTEXITCODE -ne 0) { Write-Warn2 "Python 依赖安装失败，可手动：python -m pip install requests pandas stockstats mootdx baostock xlrd openpyxl" }

Push-Location $DeployDir
& npm install --omit=dev --no-fund --no-audit 2>$null | Out-Null
Pop-Location
Write-Ok "node_modules 就绪"

if (-not (Test-Path $EnvFile)) {
  @"
PORT=$Port
DATABASE_URL=postgresql://${DbUser}:${DbPassword}@localhost:5432/${DbName}
SYNC_AT=17:30
REQUIRE_KEY=0
ACCESS_KEY=
"@ | Set-Content -Path $EnvFile -Encoding ASCII
  Write-Ok "已生成 .env"
  if ($generatedPw) { Write-Info2 "数据库密码已随机生成并写入，无需记忆" }
} else {
  Write-Info2 ".env 已存在，保持不变（端口 $Port）"
}

# ---------- 5. 防火墙 + 自启 ----------
Write-Step "[5/6] 防火墙与开机自启"
netsh advfirewall firewall delete rule name="TradeJournal$Port" 2>$null | Out-Null
netsh advfirewall firewall add rule name="TradeJournal$Port" dir=in action=allow protocol=TCP localport=$Port | Out-Null
Write-Ok "已放行入站端口 $Port"

if ($AutoStart) {
  $action = New-ScheduledTaskAction -Execute "node.exe" -Argument $ServerJs -WorkingDirectory $DeployDir
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  Register-ScheduledTask -TaskName "TradeJournal" -Action $action -Trigger $trigger -Force | Out-Null
  Write-Ok "已注册登录自启（计划任务 TradeJournal）"
} else {
  Write-Info2 "未注册自启（需要时重跑 install.bat -AutoStart）"
}

# ---------- 6. 启动 ----------
Write-Step "[6/6] 启动服务"
# 注意：不能直接 & start.ps1 —— 被调脚本里的 exit 会连带终止本脚本。
# 用子进程隔离，才能拿到退出码并继续走收尾输出。
function Invoke-ChildScript([string]$name) {
  $p = Start-Process -FilePath "powershell" `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PSScriptRoot $name)) `
    -Wait -PassThru -NoNewWindow
  return $p.ExitCode
}
Invoke-ChildScript "stop.ps1" | Out-Null
Start-Sleep -Milliseconds 500
$startCode = Invoke-ChildScript "start.ps1"
$okStart = ($startCode -eq 0)

$ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
       Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
       Select-Object -First 1).IPAddress

Write-Host ""
if ($okStart) {
  Write-Host "==================== 安装完成 ====================" -ForegroundColor Green
} else {
  Write-Host "==================== 安装完成（但启动异常）====================" -ForegroundColor Yellow
}
Write-Host "  本机：   http://localhost:$Port"
Write-Host "  局域网： http://${ip}:$Port"
Write-Host ""
Write-Host "  启动 / 重启 .\start.bat     停止 .\stop.bat"
Write-Host "  卸载        .\uninstall.bat"
Write-Host ""
if (-not $isUpgrade) {
  Write-Host "  首次使用：打开网页 → 首次初始化 → 设置管理员账号"
} else {
  Write-Host "  升级完成，数据未受影响。"
}
Write-Host "==================================================" -ForegroundColor Green
