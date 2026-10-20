# =============================================================================
#  scripts/self/windows/status.ps1 -- 查看自托管服务状态
# -----------------------------------------------------------------------------
#  用法： powershell -ExecutionPolicy Bypass -File .\status.ps1
#  展示： 进程 / 端口 / 健康检查 / 数据库 / 开机自启 / 日志 / 资源
# =============================================================================
. (Join-Path $PSScriptRoot "_common.ps1")

Write-Title "自托管 · 状态"
$Port = Get-SelfPort

# ---------- 1. 进程与端口 ----------
Write-Step "进程与端口（$Port）"
$pids = Get-ListenerPids $Port
if ($pids.Count -eq 0) {
  Write-Warn2 "无监听（服务未运行）→ 启动：.\start.bat"
} else {
  Write-Ok "运行中"
  foreach ($p in $pids) {
    $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
    if ($proc) {
      $mem = [math]::Round($proc.WorkingSet64 / 1MB, 1)
      $since = try { (Get-Date) - $proc.StartTime } catch { $null }
      $up = ""
      if ($since) {
        $up = "，已运行 {0}天{1}小时{2}分" -f $since.Days, $since.Hours, $since.Minutes
      }
      Write-Info2 "PID $p  $($proc.ProcessName)  内存 ${mem} MB$up"
    } else {
      Write-Info2 "PID $p（进程信息读不到）"
    }
  }
}

# ---------- 2. 健康检查 ----------
Write-Step "健康检查"
try {
  $r = Invoke-RestMethod "http://127.0.0.1:$Port/healthz" -TimeoutSec 5 -ErrorAction Stop
  if ($r.ok) {
    Write-Ok "接口正常"
    Write-Info2 ($r | ConvertTo-Json -Compress)
  } else {
    Write-Warn2 "有响应但 ok 不为 true：$($r | ConvertTo-Json -Compress)"
  }
} catch {
  Write-Bad "接口无响应（服务没起或端口不对）"
}

# ---------- 3. 数据库 ----------
Write-Step "数据库"
$dbUrl = Get-DbUrl
if (-not $dbUrl) {
  Write-Bad "缺少 .env 或未配置 DATABASE_URL → 运行 .\install.bat"
} else {
  Write-Info2 "连接串：$(Hide-DbPassword $dbUrl)"
  $psql = Find-Psql
  if (-not $psql) {
    Write-Warn2 "找不到 psql.exe，跳过连通性检查"
  } else {
    $old = $env:PGPASSWORD
    try {
      # 从连接串取密码，避免再问一次
      if ($dbUrl -match '://[^:]+:([^@]+)@') { $env:PGPASSWORD = $Matches[1] }
      $cnt = (& $psql $dbUrl -tAc "SELECT count(*) FROM trades" 2>$null)
      if ("$cnt".Trim() -match '^\d+$') {
        Write-Ok "连通，trades 表 $("$cnt".Trim()) 行"
      } else {
        Write-Bad "连不上（密码错误 / PostgreSQL 服务没跑 / 库不存在）"
        Write-Info2 "检查服务：Get-Service *postgres*"
      }
    } finally {
      $env:PGPASSWORD = $old
    }
  }
}

# ---------- 4. 开机自启 ----------
Write-Step "开机自启"
$task = Get-ScheduledTask -TaskName "TradeJournal" -ErrorAction SilentlyContinue
if ($task) {
  Write-Ok "已注册计划任务 TradeJournal（登录时启动）"
  Write-Info2 "状态：$($task.State)"
} else {
  Write-Info2 "未注册（需要开机自启请重跑 install.bat -AutoStart）"
}

# ---------- 5. 日志 ----------
Write-Step "日志"
if (Test-Path $LogsDir) {
  $files = Get-ChildItem $LogsDir -Filter *.log -ErrorAction SilentlyContinue
  if ($files) {
    $total = ($files | Measure-Object Length -Sum).Sum
    Write-Info2 "共 $($files.Count) 个文件 / $([math]::Round($total / 1KB, 1)) KB"
    $files | Sort-Object LastWriteTime -Descending | Select-Object -First 3 | ForEach-Object {
      Write-Info2 ("  {0}  {1}  {2:N1} KB" -f $_.Name, $_.LastWriteTime.ToString('MM-dd HH:mm'), ($_.Length / 1KB))
    }
  } else {
    Write-Info2 "目录存在但没有 .log 文件"
  }
} else {
  Write-Info2 "还没有日志目录（服务可能从未启动）"
}

# ---------- 6. 磁盘 ----------
Write-Step "磁盘"
try {
  $d = Get-PSDrive -PSProvider FileSystem | Where-Object { $RepoRoot.StartsWith($_.Root.Replace('\', ''), 'OrdinalIgnoreCase') -or $RepoRoot -like ($_.Root + '*') } | Select-Object -First 1
  if ($d -and $d.Free -ne $null) {
    Write-Info2 "所在盘 $($d.Name): 剩余 $([math]::Round($d.Free / 1GB, 1)) GB / 共 $([math]::Round(($d.Free + $d.Used) / 1GB, 1)) GB"
  }
} catch { }

$ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
       Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
       Select-Object -First 1).IPAddress
Write-Footer @(
  "本机：  http://localhost:$Port",
  "局域网：http://${ip}:$Port",
  "",
  "启动 .\start.bat   停止 .\stop.bat   重启 .\restart.bat",
  "日志 .\logs.bat    备份 .\backup.bat 升级 git pull 后重跑 install.bat"
)
