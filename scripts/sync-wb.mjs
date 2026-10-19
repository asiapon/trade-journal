/* 同步构建产物到 WorkBuddy 发布目录（保留域名：发布目录 = 旧仓库 stock-journal）
   用法：node scripts/sync-wb.mjs   （先 npm run build） */
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve('dist');
const DST = 'C:/lyz/workspace/stock-journal';       // WorkBuddy 已认领的发布目录（域名绑定于此）

if (!fs.existsSync(SRC + '/index.html')) { console.error('✗ 先 npm run build'); process.exit(1); }
/* 只同步站点文件，绝不动旧仓库的 deploy/ 与 .git */
const KEEP = new Set(['deploy', '.git', 'node_modules', 'docs', 'src', 'tests', 'scripts', 'README.md', 'schema.sql']);
const files = ['index.html', 'style.css', 'app.js', 'kline-store.js', 'analysis-extra.js', 'qa-tools.js', 'data-hub.js',
  'stock-dict.json', 'board-dict.json'];
for (const f of files) {
  if (!fs.existsSync(SRC + '/' + f)) continue;
  fs.copyFileSync(SRC + '/' + f, path.join(DST, f));
  console.log('✓', f);
}
console.log('✓ 已同步到 ' + DST + ' —— 接下来让助手执行 WorkBuddy 发布（或手动发布该目录）');
