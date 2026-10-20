/* ============================================================
   生成 ops/self/windows/*.bat 垫片（开发期工具，不参与运行）
   ------------------------------------------------------------
   为什么需要：.ps1 默认被双击时打不开（执行策略限制 + 不认扩展名），
   且 bat 能稳定传递参数。垫片必须是纯 ASCII + CRLF，否则中文 Windows
   的 cmd 会在代码页切换时误解析中文标点。

   用法：node ops/self/windows/_gen-bats.mjs
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

/** 每个 ps1 → 一个 bat 垫片（描述必须是纯 ASCII，会被写进 rem 注释） */
const SCRIPTS = [
  ['install', 'Install or upgrade self-hosted service'],
  ['start', 'Start service'],
  ['stop', 'Stop service'],
  ['restart', 'Restart service'],
  ['status', 'Show service status'],
  ['logs', 'Show logs'],
  ['backup', 'Backup database and config'],
  ['restore', 'Restore from backup'],
  ['uninstall', 'Uninstall service'],
  ['reset-db', 'Reset application database'],
  ['reset-pg', 'Reset postgres superuser password'],
];

function shim(name, desc) {
  // 纯 ASCII，CRLF 由最后统一转换
  return `@echo off
setlocal EnableDelayedExpansion
rem ============================================================
rem  ${desc}
rem  ASCII-only shim: real logic lives in ${name}.ps1
rem  Append --no-pause to skip the final keypress (for scripts/CI).
rem ============================================================

chcp 65001 >nul 2>nul

set "NOPAUSE="
set "ARGS=%*"
if not "%ARGS%"=="" (
  echo %ARGS% | findstr /i /c:"--no-pause" >nul 2>nul
  if not errorlevel 1 (
    set "NOPAUSE=1"
    set "ARGS=!ARGS:--no-pause=!"
  )
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0${name}.ps1" !ARGS!
set "RC=%ERRORLEVEL%"

echo.
if defined NOPAUSE (
  endlocal
  exit /b %RC%
)
echo   --------------------------------------------
echo    Exit code: %RC%. Press any key to close.
echo   --------------------------------------------
pause >nul
endlocal
exit /b %RC%
`;
}

let n = 0;
for (const [name, desc] of SCRIPTS) {
  const ps1 = path.join(DIR, name + '.ps1');
  if (!fs.existsSync(ps1)) {
    console.log('  跳过（没有 ' + name + '.ps1）');
    continue;
  }
  const bat = path.join(DIR, name + '.bat');
  const text = shim(name, desc).replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  fs.writeFileSync(bat, text, 'utf8');
  console.log('  ✓ ' + name + '.bat');
  n++;
}
console.log(`\n共生成 ${n} 个垫片（纯 ASCII + CRLF）`);
