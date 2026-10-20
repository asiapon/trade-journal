# =============================================================================
#  ops/self/windows/logs.ps1 -- 查看日志
# -----------------------------------------------------------------------------
#  用法：
#    .\logs.bat                  最近 40 行（最新的 app-*.log，没有则 server-out.log）
#    .\logs.bat -Lines 200       最近 200 行
#    .\logs.bat -Follow          持续跟随（Ctrl+C 退出）
#    .\logs.bat -Err             只看错误日志 server-err.log
#    .\logs.bat -List            列出所有日志文件
#    .\logs.bat -All             按时间顺序合并显示 app / out / err
# =============================================================================
param(
  [int]$Lines = 40,
  [switch]$Follow,
  [switch]$Err,
  [switch]$List,
  [switch]$All
)
. (Join-Path $PSScriptRoot "_common.ps1")

if (-not (Test-Path $LogsDir)) {
  Write-Bad "日志目录不存在：$LogsDir"
  Write-Info2 "服务可能从未启动过"
  exit 1
}

# ---------- 列出 ----------
if ($List) {
  Write-Title "日志文件"
  Get-ChildItem $LogsDir -Filter *.log -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    ForEach-Object { Write-Host ("  {0,-28} {1,10:N1} KB  {2}" -f $_.Name, ($_.Length / 1KB), $_.LastWriteTime.ToString('yyyy-MM-dd HH:mm')) }
  exit 0
}

# ---------- 选文件 ----------
if ($All) {
  $targets = Get-ChildItem $LogsDir -Filter *.log | Sort-Object Name
} elseif ($Err) {
  $f = Join-Path $LogsDir "server-err.log"
  if (-not (Test-Path $f)) { Write-Bad "没有 server-err.log"; exit 1 }
  $targets = @(Get-Item $f)
} else {
  # 优先当天 app-*.log（业务明细），否则 server-out.log
  $app = Get-ChildItem $LogsDir -Filter "app-*.log" -ErrorAction SilentlyContinue |
         Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($app) {
    $targets = @($app)
  } else {
    $out = Join-Path $LogsDir "server-out.log"
    if (Test-Path $out) { $targets = @(Get-Item $out) }
    else { Write-Bad "没有可读的日志文件（用 -List 看看）"; exit 1 }
  }
}

Write-Title "日志"
foreach ($t in $targets) {
  Write-Host "  $($t.FullName)  ($([math]::Round($t.Length / 1KB, 1)) KB)" -ForegroundColor DarkGray
}
Write-Host ""

if ($Follow) {
  Write-Host "持续跟随中，Ctrl+C 退出…" -ForegroundColor DarkGray
  if ($targets.Count -eq 1) {
    Get-Content $targets[0].FullName -Tail $Lines -Wait
  } else {
    # 多文件跟随：轮询合并，简单可靠
    $pos = @{}
    foreach ($t in $targets) {
      $pos[$t.FullName] = [math]::Max(0, $t.Length - ($Lines * 200))
    }
    while ($true) {
      foreach ($t in $targets) {
        $fs = [System.IO.File]::Open($t.FullName, 'Open', 'Read', 'ReadWrite')
        try {
          $fs.Seek($pos[$t.FullName], 'Begin') | Out-Null
          $sr = New-Object System.IO.StreamReader($fs)
          $chunk = $sr.ReadToEnd()
          if ($chunk) { Write-Host $chunk.TrimEnd() }
          $pos[$t.FullName] = $fs.Position
        } finally { $fs.Close() }
      }
      Start-Sleep -Milliseconds 800
    }
  }
} else {
  foreach ($t in $targets) {
    if ($targets.Count -gt 1) {
      Write-Host "--- $($t.Name) ---" -ForegroundColor DarkGray
    }
    Get-Content $t.FullName -Tail $Lines
  }
}
