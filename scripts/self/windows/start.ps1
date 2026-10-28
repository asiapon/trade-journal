# =============================================================================
#  scripts/self/windows/start.ps1 -- 启动自托管服务（已在运行则重启）
# -----------------------------------------------------------------------------
#  用法： powershell -ExecutionPolicy Bypass -File .\start.ps1
#         （或双击同目录 start.bat）
#  行为： 没在跑 -> 启动
#         在跑   -> 先停再起（改完 .env、拉了新代码，直接跑这个就行）
#  说明： 健康检查失败时会直接打印错误日志末尾，不用另找日志命令
# =============================================================================
. (Join-Path $PSScriptRoot "_common.ps1")

Assert-Deployed
$Port = Get-SelfPort
$existing = Get-ListenerPids $Port

# ---------- 已在运行：按重启处理 ----------
if ($existing.Count -gt 0) {
  Write-Title "自托管 · 重启"
  Write-Info2 "服务已在运行（端口 $Port，PID $($existing -join ', ')），按重启处理"
  Write-Step "停止现有实例"
  foreach ($p in $existing) {
    try {
      Stop-Process -Id $p -Force -Confirm:$false -ErrorAction Stop
      Write-Ok "已停止 PID $p"
    } catch {
      Write-Warn2 "停止 PID $p 失败：$($_.Exception.Message)"
    }
  }
  # 等端口真正释放，否则紧接着启动会撞端口
  for ($i = 0; $i -lt 20; $i++) {
    if ((Get-ListenerPids $Port).Count -eq 0) { break }
    Start-Sleep -Milliseconds 300
  }
  if ((Get-ListenerPids $Port).Count -gt 0) {
    Stop-WithError "端口 $Port 仍被占用，无法启动（该端口可能被别的程序占着）"
  }
} else {
  Write-Title "自托管 · 启动"
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
  Write-Ok "服务正常"
  Write-Footer @(
    "本机：  http://localhost:$Port",
    "局域网：http://${ip}:$Port",
    "日志：  $LogsDir",
    "停止：  .\stop.bat        卸载： .\uninstall.bat"
  )
} else {
  Write-Bad "15 秒内健康检查未通过"
  if ($proc.HasExited) {
    Write-Info2 "进程已退出（退出码 $($proc.ExitCode)）"
  } else {
    Write-Info2 "进程还活着但接口无响应"
  }
  # 直接把日志尾巴打出来：省掉「再去跑另一个命令看日志」这一步
  if ((Test-Path $errLog) -and (Get-Item $errLog).Length -gt 0) {
    Write-Host ""
    Write-Host "最近 20 行错误日志（$errLog）" -ForegroundColor DarkGray
    Get-Content $errLog -Tail 20 -Encoding UTF8 | ForEach-Object { Write-Host "    $_" }
  }
  Write-Host ""
  Write-Info2 "常见原因：PostgreSQL 没启动 / .env 里数据库密码不对 / 端口 $Port 被别的程序占用"
  exit 1
}
