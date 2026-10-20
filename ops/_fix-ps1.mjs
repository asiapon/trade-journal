/* ============================================================
   给 ops 下所有 .ps1 补 UTF-8 BOM（开发期工具）
   ------------------------------------------------------------
   为什么必须：Windows PowerShell 5.1 在无 BOM 时按系统 ANSI 代码页
   解读 .ps1，中文注释会变成乱码，进而被解析成非法 token 直接语法报错
   （典型症状：`"宸插畨瑁?node"`）。带 BOM 才会按 UTF-8 读。
   PowerShell 7 无所谓，但也兼容 BOM。

   同时保证换行为 CRLF。

   用法：node ops/_fix-ps1.mjs
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const BOM = '\uFEFF';

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.ps1')) out.push(p);
  }
  return out;
}

let fixed = 0;
let already = 0;
for (const f of walk(ROOT)) {
  const buf = fs.readFileSync(f);
  const hasBom = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
  let text = buf.toString('utf8');
  if (hasBom) text = text.replace(/^\uFEFF/, '');
  // 统一 CRLF
  const body = text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  const next = BOM + body;
  const out = Buffer.from(next, 'utf8');
  if (out.equals(buf)) {
    already++;
    console.log('  = ' + path.relative(ROOT, f));
  } else {
    fs.writeFileSync(f, out);
    fixed++;
    console.log('  ✓ ' + path.relative(ROOT, f));
  }
}
console.log(`\n已修正 ${fixed} 个，原本就正确 ${already} 个`);
