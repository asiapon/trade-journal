# =============================================================================
#  scripts/self/windows/stop.ps1 -- 停止自托管服务
# -----------------------------------------------------------------------------
#  用法： powershell -ExecutionPolicy Bypass -File .\stop.ps1
#  行为： 按端口找到监听进程并结束；本来没运行也算成功（退出码 0）
# =============================================================================
. (Join-Path $PSScriptRoot "_common.ps1")

Write-Title "自托管 · 停止"
$Port = Get-SelfPort

$pids = Get-ListenerPids $Port
if ($pids.Count -eq 0) {
  Write-Info2 "服务本来就没在运行（端口 $Port 无监听）"
  exit 0
}

Write-Step "结束进程"
$stopped = 0
foreach ($p in $pids) {
  try {
    Stop-Process -Id $p -Force -Confirm:$false -ErrorAction Stop
    Write-Ok "已停止 PID $p"
    $stopped++
  } catch {
    Write-Bad "停止 PID $p 失败：$($_.Exception.Message)"
  }
}

Start-Sleep -Milliseconds 500
if ((Get-ListenerPids $Port).Count -eq 0) {
  Write-Footer @(
    "端口 $Port 已释放",
    "重新启动 / 重启： .\start.bat"
  )
} else {
  Write-Bad "端口 $Port 仍被占用（可能需要管理员权限）"
  exit 1
}
