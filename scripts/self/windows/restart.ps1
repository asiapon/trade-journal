# =============================================================================
#  scripts/self/windows/restart.ps1 -- 重启自托管服务
# -----------------------------------------------------------------------------
#  用法： powershell -ExecutionPolicy Bypass -File .\restart.ps1
#         （或双击 restart.bat）
#  用途： 改完 .env / 拉了新代码 / 服务卡住时用
# =============================================================================
. (Join-Path $PSScriptRoot "_common.ps1")

Assert-Deployed
Write-Title "自托管 · 重启"
$Port = Get-SelfPort

# ---------- 停止 ----------
Write-Step "停止现有实例"
$pids = Get-ListenerPids $Port
if ($pids.Count -eq 0) {
  Write-Info2 "没有在运行的实例，直接启动"
} else {
  foreach ($p in $pids) {
    try {
      Stop-Process -Id $p -Force -Confirm:$false -ErrorAction Stop
      Write-Ok "已停止 PID $p"
    } catch {
      Write-Warn2 "停止 PID $p 失败：$($_.Exception.Message)"
    }
  }
  # 等端口真正释放，否则紧接着启动会撞端口
  for ($i = 0; $i -lt 10; $i++) {
    if ((Get-ListenerPids $Port).Count -eq 0) { break }
    Start-Sleep -Milliseconds 300
  }
}

# ---------- 启动 ----------
Write-Step "启动新实例"
# 用子进程：start.ps1 里的 exit 若在本进程执行，会连带终止本脚本
$p = Start-Process -FilePath "powershell" `
  -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PSScriptRoot "start.ps1")) `
  -Wait -PassThru -NoNewWindow
exit $p.ExitCode
