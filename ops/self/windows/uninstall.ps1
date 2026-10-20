# =============================================================================
#  ops/self/windows/uninstall.ps1 -- 卸载自托管服务
# -----------------------------------------------------------------------------
#  用法：
#    .\uninstall.bat               逐项询问（推荐）
#    .\uninstall.bat -Purge        连数据库一起删（危险，数据全丢）
#    .\uninstall.bat -KeepDb       只删服务与文件，数据库一定保留
#    .\uninstall.bat -DryRun       只打印会删什么，不实际执行
#
#  原则：应用自己的东西逐项确认；Node/PostgreSQL/Python 等公共组件默认保留。
# =============================================================================
param(
  [switch]$Purge,
  [switch]$KeepDb,
  [switch]$DryRun
)
. (Join-Path $PSScriptRoot "_common.ps1")

Write-Title "自托管 · 卸载（Windows）"
$Port = Get-SelfPort
$DbName = "tradejournal"
$DbUser = "tradejournal"

if (-not (Test-Admin)) { Stop-WithError "请用管理员身份运行 PowerShell" }

# dry-run 时不真的执行
function Invoke-Act {
  param([string]$Desc, [scriptblock]$Action)
  if ($DryRun) {
    Write-Info2 "[dry-run] $Desc"
    return
  }
  try { & $Action; Write-Ok $Desc }
  catch { Write-Bad "$Desc 失败：$($_.Exception.Message)" }
}

function Ask-Remove {
  param([string]$What)
  if ($Purge) { return $true }
  if ($DryRun) { Write-Info2 "[dry-run] 会询问：卸载 $What ？"; return $false }
  $a = Read-Host "  卸载 $What ？(y/N)"
  return ($a -match '^[Yy]')
}

Write-Host ""
Write-Warn2 "以下操作逐个确认；公共组件（Node / PostgreSQL / Python）默认保留。"
if ($Purge) { Write-Bad "已指定 -Purge：数据库也会被删除！" }
if ($KeepDb) { Write-Info2 "已指定 -KeepDb：数据库一定保留" }

# ---------- 1. 服务 ----------
Write-Step "停止服务"
$pids = Get-ListenerPids $Port
if ($pids.Count -eq 0) {
  Write-Info2 "服务本来就没在运行"
} else {
  foreach ($p in $pids) {
    Invoke-Act "结束 PID $p" { Stop-Process -Id $p -Force -Confirm:$false -ErrorAction Stop }
  }
}

# ---------- 2. 计划任务与防火墙 ----------
Write-Step "计划任务与防火墙"
$task = Get-ScheduledTask -TaskName "TradeJournal" -ErrorAction SilentlyContinue
if ($task) {
  Invoke-Act "移除计划任务 TradeJournal" { Unregister-ScheduledTask -TaskName "TradeJournal" -Confirm:$false }
} else {
  Write-Info2 "没有注册自启任务"
}
$rules = netsh advfirewall firewall show rule name=all 2>$null | Select-String "TradeJournal"
if ($rules) {
  Invoke-Act "移除防火墙规则" { netsh advfirewall firewall delete rule name="TradeJournal$Port" | Out-Null }
} else {
  Write-Info2 "没有找到相关防火墙规则"
}

# ---------- 3. 应用文件 ----------
Write-Step "应用文件"
if ((Test-Path $EnvFile) -and (Ask-Remove ".env（含数据库密码）")) {
  Invoke-Act "删除 .env" { Remove-Item $EnvFile -Force }
}
$nm = Join-Path $DeployDir "node_modules"
if ((Test-Path $nm) -and (Ask-Remove "node_modules（后端依赖，重装 = npm install）")) {
  Invoke-Act "删除 node_modules" { Remove-Item $nm -Recurse -Force }
}
if ((Test-Path $PacksDir) -and (Ask-Remove "packs（已安装的技能包）")) {
  Invoke-Act "删除 packs" { Remove-Item $PacksDir -Recurse -Force }
}
if ((Test-Path $LogsDir) -and (Ask-Remove "logs（历史日志）")) {
  Invoke-Act "删除 logs" { Remove-Item $LogsDir -Recurse -Force }
}
if ((Test-Path $BackupDir) -and (Ask-Remove "backups（备份文件，建议先拷走）")) {
  Invoke-Act "删除 backups" { Remove-Item $BackupDir -Recurse -Force }
}

# ---------- 4. 数据库 ----------
Write-Step "数据库（$DbName）"
if ($KeepDb) {
  Write-Info2 "按 -KeepDb 保留数据库"
} else {
  Write-Bad "删除数据库 = 交易记录 / 自选 / 问答历史 / 持仓全部清空，不可恢复！"
  if (Ask-Remove "数据库 $DbName 与角色 $DbUser") {
    $psql = Find-Psql
    if (-not $psql) {
      Write-Bad "找不到 psql.exe，无法删库"
    } else {
      $pw = Read-Host "  输入 postgres 超级用户密码" -AsSecureString
      $pgPwd = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($pw))
      $old = $env:PGPASSWORD
      $env:PGPASSWORD = $pgPwd
      try {
        Invoke-Act "删除数据库 $DbName" {
          & $psql -U postgres -h 127.0.0.1 -c "DROP DATABASE IF EXISTS $DbName;" | Out-Null
        }
        Invoke-Act "删除角色 $DbUser" {
          & $psql -U postgres -h 127.0.0.1 -c "DROP ROLE IF EXISTS $DbUser;" | Out-Null
        }
      } finally { $env:PGPASSWORD = $old }
    }
  } else {
    Write-Info2 "已保留数据库（推荐——重装还能接着用）"
  }
}

# ---------- 5. Python 依赖 ----------
Write-Step "Python 依赖"
if (Ask-Remove "pip 包（requests pandas stockstats mootdx baostock xlrd openpyxl）") {
  Invoke-Act "卸载 pip 包" {
    & python -m pip uninstall -y requests pandas stockstats mootdx baostock xlrd openpyxl 2>&1 | Out-Null
  }
} else {
  Write-Info2 "保留 Python 依赖（别的项目可能也在用）"
}

# ---------- 6. 公共组件 ----------
Write-Step "公共组件（默认保留，回车 = 保留）"
if (Ask-Remove "Node.js（机器上可能有别的程序依赖）") {
  Invoke-Act "卸载 Node.js" { winget uninstall -e --id OpenJS.NodeJS.LTS 2>&1 | Out-Null }
} else {
  Write-Info2 "保留 Node.js"
}
if (Ask-Remove "PostgreSQL（会删除服务器上全部数据库）") {
  Invoke-Act "卸载 PostgreSQL" { winget uninstall -e --id PostgreSQL.PostgreSQL.16 2>&1 | Out-Null }
} else {
  Write-Info2 "保留 PostgreSQL"
}

if ($DryRun) {
  Write-Footer @("以上为 dry-run，未实际改动任何东西。", "去掉 -DryRun 才会真正执行。")
} else {
  Write-Footer @("重装： .\install.bat（保留的组件会被复用）", "数据库保留的话，重装后数据还在。")
}
