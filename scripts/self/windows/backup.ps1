# =============================================================================
#  scripts/self/windows/backup.ps1 -- 备份数据库与配置
# -----------------------------------------------------------------------------
#  用法：
#    .\backup.bat                        备份到 <仓库>\backups\
#    .\backup.bat -Out D:\bak            指定目录
#    .\backup.bat -Keep 7                只保留最近 7 份（默认 10，0=不清理）
#
#  产出： trade-journal-YYYYmmdd-HHmmss.zip
#         内含 db.dump（pg_dump 自定义格式）+ app.env + packs\
# =============================================================================
param(
  [string]$Out = "",
  [int]$Keep = 10
)
. (Join-Path $PSScriptRoot "_common.ps1")

Assert-Deployed
Write-Title "自托管 · 备份"

if (-not $Out) { $Out = $BackupDir }

$dbUrl = Get-DbUrl
if (-not $dbUrl) { Stop-WithError "缺少 .env 或未配置 DATABASE_URL" }
if ($dbUrl -notmatch '^postgres') { Stop-WithError "DATABASE_URL 不是 PostgreSQL 连接串" }

$psql = Find-Psql
if (-not $psql) { Stop-WithError "找不到 psql.exe（PostgreSQL 未安装或不在标准路径）" }
$pgDump = Join-Path (Split-Path -Parent $psql) "pg_dump.exe"
$pgRestore = Join-Path (Split-Path -Parent $psql) "pg_restore.exe"
if (-not (Test-Path $pgDump)) { Stop-WithError "找不到 pg_dump.exe（$pgDump）" }

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
New-Item -ItemType Directory -Path $Out -Force | Out-Null
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("tj-bak-" + $stamp)
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

$old = $env:PGPASSWORD
try {
  if ($dbUrl -match '://[^:]+:([^@]+)@') { $env:PGPASSWORD = $Matches[1] }

  # ---------- 1. 数据库 ----------
  Write-Step "导出数据库"
  $dumpFile = Join-Path $tmp "db.dump"
  & $pgDump $dbUrl -Fc -f $dumpFile 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $dumpFile)) {
    Write-Bad "pg_dump 失败"
    Write-Info2 "常见原因：DATABASE_URL 密码不对 / PostgreSQL 没跑 / 库不存在"
    Write-Info2 "检查服务：Get-Service *postgres*"
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
  }
  $sz = [math]::Round((Get-Item $dumpFile).Length / 1KB, 1)
  Write-Ok "已导出 db.dump（$sz KB）"
} finally {
  $env:PGPASSWORD = $old
}

# ---------- 2. 配置 ----------
Write-Step "备份配置"
if (Test-Path $EnvFile) {
  Copy-Item $EnvFile (Join-Path $tmp "app.env") -Force
  Write-Ok ".env 已备份（内含数据库密码，注意保管）"
} else {
  Write-Warn2 ".env 不存在，跳过"
}

# ---------- 3. 技能包 ----------
if (Test-Path $PacksDir) {
  Write-Step "备份技能包"
  Copy-Item $PacksDir (Join-Path $tmp "packs") -Recurse -Force -ErrorAction SilentlyContinue
  Write-Ok "packs 已备份"
}

# ---------- 4. 打包 ----------
Write-Step "打包"
$zip = Join-Path $Out "trade-journal-$stamp.zip"
try {
  Compress-Archive -Path (Join-Path $tmp "*") -DestinationPath $zip -Force -ErrorAction Stop
  Write-Ok "已生成 $(Split-Path -Leaf $zip)（$([math]::Round((Get-Item $zip).Length / 1KB, 1)) KB）"
} catch {
  Write-Bad "打包失败：$($_.Exception.Message)"
  Write-Info2 "中间文件保留在：$tmp"
  exit 1
}
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

# ---------- 5. 清理旧备份 ----------
if ($Keep -gt 0) {
  Write-Step "清理旧备份（保留最近 $Keep 份）"
  $all = Get-ChildItem $Out -Filter "trade-journal-*.zip" -File | Sort-Object LastWriteTime -Descending
  if ($all.Count -gt $Keep) {
    $all | Select-Object -Skip $Keep | ForEach-Object {
      Remove-Item $_.FullName -Force
      Write-Info2 "已删除 $($_.Name)"
    }
  } else {
    Write-Info2 "当前 $($all.Count) 份，未超过上限"
  }
}

$totalMB = [math]::Round(((Get-ChildItem $Out -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1MB), 1)
Write-Footer @(
  "备份目录：$Out",
  "总占用：  $totalMB MB",
  "恢复到本机： .\restore.bat `"$zip`"",
  "拷到别处：   copy `"$zip`" \\nas\backup\"
)
