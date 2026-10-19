/* 同步构建产物到 WorkBuddy 发布暂存目录（v0.13.0：旧认领目录已废弃）
   用法：npm run build && node scripts/sync-wb.mjs
   暂存目录 = C:\lyz\workspace\trade-journal-app（纯 dist 快照），
   由助手用 Sites 发布该目录生成/更新应用；可随时整个删除，下次脚本自动重建。 */
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve('dist');
const DST = 'C:/lyz/workspace/trade-journal-app';

if (!fs.existsSync(SRC + '/index.html')) { console.error('✗ 先 npm run build'); process.exit(1); }
if (fs.existsSync(DST)) fs.rmSync(DST, { recursive: true, force: true });

function cp(dir, rel) {
  fs.mkdirSync(path.join(DST, rel), { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    const s = path.join(dir, name);
    const d = path.join(DST, rel, name);
    if (fs.statSync(s).isDirectory()) cp(s, path.join(rel, name));
    else { fs.copyFileSync(s, d); console.log('✓', path.join(rel, name).replace(/\\/g, '/')); }
  }
}
cp(SRC, '');
console.log('✓ 已同步到 ' + DST + ' —— 接下来让助手发布该目录（或用 发布为应用 功能）');
