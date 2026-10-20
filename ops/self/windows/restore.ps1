# =============================================================================
#  ops/self/windows/restore.ps1 -- 从备份恢复
# -----------------------------------------------------------------------------
#  用法：
#    .\restore.bat backups\trade-journal-20261020-113000.zip
#    .\restore.bat <文件> -Yes            跳过确认（脚本调用）
#
#  注意：数据库是「覆盖式」恢复 —— 先删同名库再重建，当前数据全部丢失。
#        恢复前会自动先备份一次，存为 pre-restore-*.zip。
# =============================================================================
param(
  [Parameter(Mandatory = $false, Position = 0)][string]$File = "",
  [switch]$Yes
)
. (Join-Path $PSScriptRoot "_common.ps1")

Write-Title "自托管 · 恢复"

if (-not $File) { Stop-WithError "用法：.\restore.bat <备份文件.zip>" }
if (-not (Test-Path $File)) { Stop-WithError "文件不存在：$File" }
$File = (Resolve-Path $File).Path

$psql = Find-Psql
if (-not $psql) { Stop-WithError "找不到 psql.exe（PostgreSQL 未安装）" }
$pgBin = Split-Path -Parent $psql
$pgRestore = Join-Path $pgBin "pg_restore.exe"
if (-not (Test-Path $pgRestore)) { Stop-WithError "找不到 pg_restore.exe" }

# ---------- 解包 ----------
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("tj-rs-" + $stamp)
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

Write-Step "解包"
try {
  Expand-Archive -Path $File -DestinationPath $tmp -Force -ErrorAction Stop
  Write-Ok "已解包到临时目录"
} catch {
  Stop-WithError "解包失败（文件损坏？）：$($_.Exception.Message)"
}
$dumpFile = Join-Path $tmp "db.dump"
if (-not (Test-Path $dumpFile)) { Stop-WithError "包里没有 db.dump，不是本脚本产出的备份" }

# ---------- 连接串 ----------
$dbUrl = ""
$bakEnv = Join-Path $tmp "app.env"
if (Test-Path $bakEnv) {
  Get-Content $bakEnv | ForEach-Object {
    if ($_ -match '^\s*DATABASE_URL\s*=\s*(.+)$') { $dbUrl = $Matches[1].Trim() }
  }
  if ($dbUrl) { Write-Info2 "使用备份内的 .env 连接串" }
}
if (-not $dbUrl) {
  $dbUrl = Get-DbUrl
  if (-not $dbUrl) { Stop-WithError "缺少 .env，且备份里也没有配置。请先 .\install.bat" }
  Write-Info2 "使用当前 .env 的连接串"
}
if ($dbUrl -notmatch '^postgres') { Stop-WithError "DATABASE_URL 不是 PostgreSQL 连接串" }

# ---------- 解析库名 / 用户 ----------
$dbName = ""
if ($dbUrl -match '/([^/?]+)(\?|$)') { $dbName = $Matches[1] }
$dbUser = ""
if ($dbUrl -match '://([^:@]+)') { $dbUser = $Matches[1] }
if (-not $dbName) { Stop-WithError "无法从连接串解析库名" }

Write-Host ""
Write-Bad "这会覆盖数据库「$dbName」，当前数据将全部丢失！"
Write-Info2 "来源：$File"
Write-Info2 "目标：$dbName（用户 $dbUser）"

if (-not $Yes) {
  Write-Host ""
  $ans = Read-Host "  确认恢复请输入 yes（其他任意键取消）"
  if ($ans -ne "yes") {
    Write-Host "  已取消，什么都没改。"
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    exit 0
  }
}

$old = $env:PGPASSWORD
try {
  if ($dbUrl -match '://[^:]+:([^@]+)@') { $env:PGPASSWORD = $Matches[1] }

  # ---------- 恢复前自保 ----------
  Write-Step "恢复前自动备份当前数据"
  try {
    # 子进程调用：backup.ps1 失败时会 exit，直接 & 会连带终止本脚本
    $bakScript = Join-Path $PSScriptRoot "backup.ps1"
    $p = Start-Process -FilePath "powershell" `
      -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $bakScript, "-Keep", "0") `
      -Wait -PassThru -NoNewWindow
    $latest = Get-ChildItem $BackupDir -Filter "trade-journal-*.zip" -ErrorAction SilentlyContinue |
              Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($latest) {
      $pre = Join-Path $BackupDir ("pre-restore-" + $stamp + ".zip")
      Move-Item $latest.FullName $pre -Force
      Write-Ok "已保存当前数据：$(Split-Path -Leaf $pre)"
    } elseif ($p.ExitCode -ne 0) {
      Write-Warn2 "自动备份失败（退出码 $($p.ExitCode)），继续恢复（风险自负）"
    }
  } catch {
    Write-Warn2 "自动备份失败，继续恢复（风险自负）"
  }

  # ---------- 重建库 ----------
  Write-Step "重建数据库"
  # 连接串指向目标库，删库时要连到 postgres 库
  $adminUrl = [regex]::Replace($dbUrl, "/$([regex]::Escape($dbName))(\?|$)", '/postgres$1')
  & $psql $adminUrl -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$dbName' AND pid <> pg_backend_pid();" 2>&1 | Out-Null
  & $psql $adminUrl -c "DROP DATABASE IF EXISTS $dbName;" 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Bad "删库失败（权限不足 / 有活动连接？）" }
  & $psql $adminUrl -c "CREATE DATABASE $dbName OWNER $dbUser;" 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Stop-WithError "建库失败" }
  Write-Ok "数据库已重建"

  # ---------- 导入 ----------
  Write-Step "导入数据"
  $errLog = Join-Path $tmp "restore-err.log"
  & $pgRestore -d $dbUrl --no-owner --no-privileges $dumpFile 2> $errLog
  if ($LASTEXITCODE -eq 0) {
    Write-Ok "导入完成"
  } else {
    $errText = if (Test-Path $errLog) { Get-Content $errLog -Raw } else { "" }
    if ($errText -match '(?i)error') {
      Write-Warn2 "导入有错误，前 10 行："
      Get-Content $errLog -TotalCount 10 | ForEach-Object { Write-Host "    $_" }
    } else {
      Write-Ok "导入完成（只有警告）"
    }
  }

  # ---------- 校验 ----------
  Write-Step "校验"
  $cnt = (& $psql $dbUrl -tAc "SELECT count(*) FROM trades" 2>$null)
  if ("$cnt".Trim() -match '^\d+$') {
    Write-Ok "trades 表 $("$cnt".Trim()) 行"
  } else {
    Write-Bad "查不到 trades 表，恢复可能不完整"
  }
} finally {
  $env:PGPASSWORD = $old
}

# ---------- 还原 .env ----------
if (Test-Path $bakEnv) {
  Write-Step "还原配置"
  if (Test-Path $EnvFile) {
    $keep = "$EnvFile.bak-$stamp"
    Copy-Item $EnvFile $keep -Force
    Write-Warn2 "原 .env 已备份为 $(Split-Path -Leaf $keep)"
  }
  Copy-Item $bakEnv $EnvFile -Force
  Write-Ok ".env 已还原"
}

# ---------- 还原 packs ----------
$bakPacks = Join-Path $tmp "packs"
if (Test-Path $bakPacks) {
  Write-Step "还原技能包"
  New-Item -ItemType Directory -Path $PacksDir -Force | Out-Null
  Copy-Item (Join-Path $bakPacks "*") $PacksDir -Recurse -Force -ErrorAction SilentlyContinue
  Write-Ok "packs 已还原"
}

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

Write-Footer @(
  "重启服务使配置生效： .\restart.bat",
  "查看状态：           .\status.bat"
)
