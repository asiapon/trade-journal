/* ============================================================
   scripts/wb/sync.mjs —— 构建并同步到 WorkBuddy 发布暂存目录
   ------------------------------------------------------------
   WorkBuddy 通道无法纯命令行上线（必须界面点「发布」），
   这里做的是把 dist 拷到暂存目录，让界面能直接发布该目录。
   暂存目录在仓库外，可随时删除重建。
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { DIST, WB_DIR } from '../lib/paths.mjs';
import { prepare } from '../lib/build.mjs';
import { title, step, ok, info, warn, footer, C } from '../lib/ui.mjs';

function copyTree(src, dst, rel = '') {
  fs.mkdirSync(path.join(dst, rel), { recursive: true });
  let n = 0;
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dst, rel, name);
    if (fs.statSync(s).isDirectory()) n += copyTree(s, dst, path.join(rel, name));
    else { fs.copyFileSync(s, d); n++; }
  }
  return n;
}

export async function run() {
  title('WorkBuddy · 同步发布目录');
  prepare();

  step('同步到暂存目录');
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    warn('dist/index.html 不存在，构建可能失败');
    return;
  }

  /* 先删后拷：避免旧文件残留导致线上版本混杂（sync-wb 一直这么做） */
  if (fs.existsSync(WB_DIR)) {
    fs.rmSync(WB_DIR, { recursive: true, force: true });
    info('已清空旧暂存目录');
  }
  const n = copyTree(DIST, WB_DIR);
  ok(`已拷入 ${n} 个文件`);
  info('目标：' + WB_DIR);

  footer([
    C.y('注意：这一步只是准备好文件，还没上线。'),
    '还需要在 WorkBuddy 界面点「发布 / 更新」才算生效。',
    '',
    C.d('想完全命令行上线：') + ' node scripts/cli.mjs cf deploy（Cloudflare 通道）',
    C.d('想自建服务器：    ') + ' node scripts/cli.mjs self install（见 scripts/OPS.md）',
  ]);
}
