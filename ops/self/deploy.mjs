/* ============================================================
   ops/self/deploy.mjs —— 把构建产物同步到自托管服务器
   ------------------------------------------------------------
   两种自托管升级方式，本脚本做的是第二种：
     ① 在服务器上 git pull && npm run build（server.js 直接读 dist）
     ② 本地构建 → 同步 dist 到服务器（本脚本，适合不便登服务器的场景）

   优先用 rsync（增量、快），没有就退回 scp。
   需要 .env.local 里配 SELF_HOST（user@host）与 SELF_PATH（可选）。
   ============================================================ */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DIST, exists } from '../lib/paths.mjs';
import { loadEnvFile } from '../lib/env.mjs';
import { prepare } from '../lib/build.mjs';
import { title, step, ok, warn, info, die, footer, C } from '../lib/ui.mjs';

const DEFAULT_PATH = '/opt/stockjournal/dist';

function has(cmd) {
  const r = spawnSync(cmd, ['--version'], { stdio: 'ignore', shell: true });
  return r.status === 0 || r.status === 1;   // rsync --version 返回 0；scp 可能返回 1
}

export async function run(argv = []) {
  title('自托管 · 同步产物到服务器');
  loadEnvFile();

  const host = process.env.SELF_HOST;
  const dest = process.env.SELF_PATH || DEFAULT_PATH;
  const skipBuild = argv.includes('--no-build');
  const restart = argv.includes('--restart');

  if (!host) {
    warn('未配置 SELF_HOST');
    info('推荐写进 .env.local：');
    console.log('    SELF_HOST=root@1.2.3.4');
    console.log('    SELF_PATH=/opt/stockjournal/dist');
    console.log('');
    info('或者临时指定：SELF_HOST=user@host node ops/cli.mjs self deploy');
    console.log('');
    info(C.d('不想配这个也行 —— 直接在服务器上 git pull && npm run build 更简单'));
    die('缺少 SELF_HOST');
  }

  /* ---------- 构建 ---------- */
  if (skipBuild) {
    if (!exists(path.join(DIST, 'index.html'))) die('按 --no-build 跳过构建，但 dist 不存在');
    step('跳过构建（--no-build）');
    ok('使用现有 dist');
  } else {
    prepare();
  }

  /* ---------- 选择同步工具 ---------- */
  step('同步到 ' + host + ':' + dest);
  const useRsync = has('rsync');
  const useScp = !useRsync && has('scp');

  if (!useRsync && !useScp) {
    die('本机既没有 rsync 也没有 scp，无法同步。可选：在服务器上 git pull + npm run build');
  }

  let cmd;
  if (useRsync) {
    /* --delete：删掉服务器上 dist 里已不存在的旧文件，避免版本混杂
       --exclude .DS_Store 之类系统垃圾 */
    cmd = `rsync -az --delete --exclude '.DS_Store' --exclude 'Thumbs.db' "${DIST}/" "${host}:${dest}/"`;
  } else {
    cmd = `scp -r "${DIST}"/* "${host}:${dest}/"`;
  }
  info(cmd);

  const r = spawnSync(cmd, { stdio: 'inherit', shell: true });
  if (r.status !== 0) {
    warn(useRsync ? 'rsync 失败' : 'scp 失败');
    info('常见原因：SSH 免密没配好 / 目标目录不存在 / 端口不是 22（用 ~/.ssh/config 配 Host）');
    info('先手工试一下：ssh ' + host + ' "ls -ld ' + dest + '"');
    die('同步失败', r.status ?? 1);
  }
  ok('已同步 ' + (useRsync ? '（rsync 增量）' : '（scp 全量）'));

  /* ---------- 重启 ---------- */
  if (restart) {
    step('重启远端服务');
    const rr = spawnSync(
      `ssh ${host} "sudo systemctl restart trade-journal || sudo systemctl restart stock-journal"`,
      { stdio: 'inherit', shell: true },
    );
    if (rr.status === 0) ok('远端服务已重启');
    else warn('远端重启失败，请手动执行：ssh ' + host + ' "sudo systemctl restart trade-journal"');
  }

  footer([
    '产物已更新到服务器',
    '',
    restart ? C.d('服务已重启，刷新页面即可') : '需要重启服务才生效：',
    restart ? '' : '  ssh ' + host + ' "sudo systemctl restart trade-journal"',
    restart ? '' : C.d('或加 --restart 参数让本脚本代劳'),
    '',
    C.d('若服务器上还没装服务：') + ' 在服务器上跑 ops/self/linux/install.sh',
  ]);
}
