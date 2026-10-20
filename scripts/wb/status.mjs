/* ============================================================
   scripts/wb/status.mjs —— 查看 WorkBuddy 通道状态
   ------------------------------------------------------------
   核对三件事：
     1. 本地 dist 是否已构建、何时构建
     2. 暂存目录是否存在、有几个文件
     3. 暂存目录与 dist 是否一致（决定要不要重新 sync）
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { DIST, WB_DIR, exists } from '../lib/paths.mjs';
import { distSummary, humanSize } from '../lib/build.mjs';
import { title, step, ok, warn, info, bad, kv, C, footer } from '../lib/ui.mjs';

/** 统计目录：文件数 + 总字节 + 最新 mtime */
function stat(dir) {
  if (!exists(dir)) return null;
  let files = 0;
  let bytes = 0;
  let newest = 0;
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else {
        files++;
        bytes += st.size;
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      }
    }
  };
  try { walk(dir); } catch { return null; }
  return { files, bytes, newest };
}

export async function run() {
  title('WorkBuddy · 状态');

  /* ---------- 本地构建产物 ---------- */
  step('本地 dist');
  const ds = distSummary();
  if (ds) {
    ok('已构建');
    kv([
      ['文件数', String(ds.files)],
      ['体积', humanSize(ds.bytes)],
      ['构建时间', ds.mtime.toLocaleString('zh-CN')],
    ]);
  } else {
    bad('未构建（或 dist/index.html 缺失）');
    info('运行 node scripts/cli.mjs wb sync 会自动构建');
  }

  /* ---------- 暂存目录 ---------- */
  step('发布暂存目录');
  kv([['路径', WB_DIR]]);
  const st = stat(WB_DIR);
  if (!st) {
    warn('暂存目录不存在');
    info('运行 node scripts/cli.mjs wb sync 生成');
  } else {
    ok('存在');
    kv([
      ['文件数', String(st.files)],
      ['体积', humanSize(st.bytes)],
      ['最近写入', new Date(st.newest).toLocaleString('zh-CN')],
    ]);

    /* ---------- 一致性 ---------- */
    step('与本地 dist 是否一致');
    if (!ds) {
      warn('本地未构建，无法比较');
    } else if (st.files !== ds.files) {
      warn(`文件数不同（暂存 ${st.files} / dist ${ds.files}）→ 需要 node scripts/cli.mjs wb sync`);
    } else if (st.newest < ds.mtime.getTime() - 2000) {
      warn('暂存目录比 dist 旧 → 需要 node scripts/cli.mjs wb sync');
    } else {
      ok('已同步（文件数一致且不比 dist 旧）');
    }
  }

  footer([
    C.y('WorkBuddy 通道无法纯命令行上线。'),
    '它只负责把文件放到暂存目录，真正的发布要在界面点一次。',
    '',
    C.d('完全命令行上线：') + ' node scripts/cli.mjs cf deploy',
    C.d('自建服务器：    ') + ' node scripts/cli.mjs self install（Linux/Windows 各有脚本）',
  ]);
}
