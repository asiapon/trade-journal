/* ============================================================
   scripts/lib/ui.mjs —— 统一终端输出
   ------------------------------------------------------------
   所有 scripts 脚本共用，保证三条通道的输出风格一致。
   Windows 旧控制台默认 GBK，这里在首次导入时切 UTF-8 代码页。
   ============================================================ */
import { spawnSync } from 'node:child_process';

/* Windows 下先切代码页，否则中文全乱码。失败无所谓（新终端本就 UTF-8）。 */
if (process.platform === 'win32') {
  try { spawnSync('chcp', ['65001'], { shell: true, stdio: 'ignore' }); } catch { /* */ }
}

const on = process.stdout.isTTY || process.env.FORCE_COLOR;
const c = (code) => (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const C = {
  g: c(32), r: c(31), y: c(33), b: c(36), m: c(35),
  d: c(90), bold: c(1), und: c(4),
};

/** 一级标题 */
export function title(t) {
  console.log('\n' + C.bold(t));
  console.log(C.d('─'.repeat(Math.min(60, Math.max(20, t.length * 2)))));
}

/** 二级步骤 */
export function step(t) {
  console.log('\n' + C.b('▶ ' + t));
}

export const ok = (t) => console.log('  ' + C.g('✓') + ' ' + t);
export const warn = (t) => console.log('  ' + C.y('!') + ' ' + t);
export const info = (t) => console.log('  ' + C.d('·') + ' ' + t);
export const bad = (t) => console.log('  ' + C.r('✗') + ' ' + t);

/** 致命错误：打印并退出 */
export function die(t, code = 1) {
  console.error('\n  ' + C.r('✗ ' + t));
  process.exit(code);
}

/** 键值对齐输出（STATUS 用） */
export function kv(pairs, indent = 2) {
  const pad = Math.max(...pairs.map(([k]) => k.length));
  for (const [k, v] of pairs) {
    console.log(' '.repeat(indent) + C.d(k.padEnd(pad)) + '  ' + v);
  }
}

/** 收尾提示块 */
export function footer(lines) {
  console.log('\n' + C.d('─'.repeat(50)));
  for (const l of lines) console.log('  ' + l);
  console.log(C.d('─'.repeat(50)));
}
