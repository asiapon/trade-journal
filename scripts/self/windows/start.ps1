# =============================================================================
#  scripts/self/windows/start.ps1 -- 启动自托管服务
# -----------------------------------------------------------------------------
#  用法： powershell -ExecutionPolicy Bypass -File .\start.ps1
#         （或双击同目录 start.bat）
#  行为： 已在运行则不重复启动；未运行则以隐藏窗口常驻并做健康检查
# =============================================================================
. (Join-Path $PSScriptRoot "_common.ps1")

Assert-Deployed
Write-Title "自托管 · 启动"
$Port = Get-SelfPort

# ---------- 已经跑起来了？ ----------
$existing = Get-ListenerPids $Port
if ($existing.Count -gt 0) {
  Write-Ok "服务已在运行（端口 $Port，PID $($existing -join ', ')）"
  Write-Info2 "需要重启请用 .\restart.bat"
  exit 0
}

# ---------- 启动 ----------
Write-Step "启动 node server.js"
New-Item -ItemType Directory -Path $LogsDir -Force | Out-Null

# 环境里同时存在 http_proxy/HTTP_PROXY 等大小写重复键时，
# Start-Process 重定向会崩（.NET 的已知问题），先去掉小写重复项
$envKeys = @('http_proxy', 'https_proxy', 'no_proxy', 'all_proxy')
foreach ($k in $envKeys) {
  if (Test-Path ("env:" + $k)) { Remove-Item ("env:" + $k) -ErrorAction SilentlyContinue }
}

$outLog = Join-Path $LogsDir "server-out.log"
$errLog = Join-Path $LogsDir "server-err.log"
$proc = Start-Process -FilePath "node" `
  -ArgumentList $ServerJs `
  -WorkingDirectory $DeployDir `
  -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput $outLog `
  -RedirectStandardError $errLog

if (-not $proc) { Stop-WithError "启动失败（Start-Process 返回空）" }
Write-Info2 "PID $($proc.Id)，日志：$LogsDir"

# ---------- 健康检查 ----------
Write-Step "健康检查"
if (Wait-Health $Port 15) {
  $ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
         Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
         Select-Object -First 1).IPAddress
  Write-Ok "启动成功"
  Write-Footer @(
    "本机：  http://localhost:$Port",
    "局域网：http://${ip}:$Port",
    "日志：  .\logs.bat          停止： .\stop.bat",
    "重启：  .\restart.bat       状态： .\status.bat"
  )
} else {
  Write-Bad "15 秒内健康检查未通过"
  if (-not $proc.HasExited) {
    Write-Info2 "进程还活着但接口无响应，看日志：$errLog"
  } else {
    Write-Info2 "进程已退出（退出码 $($proc.ExitCode)）"
  }
  Write-Info2 "常见原因：PostgreSQL 没启动 / .env 里数据库密码不对 / 端口被别的程序占用"
  Write-Info2 "看错误详情：.\logs.bat -Err 40"
  exit 1
}
