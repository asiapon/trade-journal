/* 同步构建产物到 WorkBuddy 发布目录（保留域名：发布目录 = 旧仓库 stock-journal）
   用法：npm run build && node scripts/sync-wb.mjs
   v0.12.1：适配 Vite dist 结构（index.html + assets/ + public 经典脚本），
   并清掉旧版平铺站点文件（app.js/style.css 等已并入 assets），绝不动 deploy/.git/docs。 */
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve('dist');
const DST = 'C:/lyz/workspace/stock-journal';       // WorkBuddy 已认领的发布目录（域名绑定于此）

if (!fs.existsSync(SRC + '/index.html')) { console.error('✗ 先 npm run build'); process.exit(1); }

/* 旧版平铺站点文件（已不存在于 dist）→ 从发布目录清除，避免残留死代码 */
const STALE = ['app.js', 'style.css', 'start.bat', 'start.sh', 'test-voice.html', 'schema.sql'];
for (const f of STALE) {
  const p = path.join(DST, f);
  if (fs.existsSync(p)) { fs.rmSync(p); console.log('✗ 清除旧文件', f); }
}
if (fs.existsSync(path.join(DST, 'assets'))) fs.rmSync(path.join(DST, 'assets'), { recursive: true, force: true });

/* 递归拷贝 dist/*（index.html + assets/ + 经典脚本 + 字典） */
function cp(dir, rel) {
  for (const name of fs.readdirSync(dir)) {
    const s = path.join(dir, name);
    const d = path.join(DST, rel, name);
    if (fs.statSync(s).isDirectory()) { fs.mkdirSync(d, { recursive: true }); cp(s, path.join(rel, name)); }
    else { fs.copyFileSync(s, d); console.log('✓', path.join(rel, name).replace(/\\/g, '/')); }
  }
}
cp(SRC, '');
console.log('✓ 已同步到 ' + DST + ' —— 接下来让助手执行 WorkBuddy 发布（或手动发布该目录）');
