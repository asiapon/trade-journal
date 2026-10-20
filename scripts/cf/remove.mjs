/* ============================================================
   scripts/cf/remove.mjs —— 删除 Cloudflare 部署（危险）
   ------------------------------------------------------------
   删除内容：Worker 脚本 + D1 数据库（全部账号与记账数据）
   保护：必须输入 yes 确认，或显式传 --yes（供脚本调用）
   ============================================================ */
import readline from 'node:readline/promises';
import { ensureCreds, wrangler, WORKER_NAME, DB_NAME } from './lib.mjs';
import { writeDbId } from '../lib/paths.mjs';
import { title, step, ok, warn, info, bad, kv, C } from '../lib/ui.mjs';

export async function run(argv = []) {
  title('Cloudflare · 删除部署');
  ensureCreds();

  const yes = argv.includes('--yes') || argv.includes('-y');

  console.log('');
  warn(C.r('以下操作不可恢复：'));
  kv([
    [C.r('1)'), `Worker「${WORKER_NAME}」及其线上地址`],
    [C.r('2)'), `D1 数据库「${DB_NAME}」—— 全部账号与记账数据`],
  ]);
  console.log('');
  info('GitHub 代码不受影响；重装：node scripts/cli.mjs cf bootstrap && node scripts/cli.mjs cf deploy');
  info('想保留数据请先导出：node scripts/cli.mjs cf status 看到表后自行备份');

  if (!yes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ans = (await rl.question('\n  确认删除请输入 ' + C.y('yes') + '（其他任意键取消）：')).trim();
    rl.close();
    if (ans !== 'yes') {
      console.log('\n  已取消，什么都没删。');
      return;
    }
  }

  step('删除 Worker');
  wrangler(['delete', '--name', WORKER_NAME, '--yes']);

  step('删除 D1 数据库');
  const r = wrangler(['d1', 'delete', DB_NAME, '--yes']);
  if (r.status === 0) {
    const touched = writeDbId('TO_CREATE_ON_FIRST_DEPLOY');
    ok('database_id 已复位为占位符：' + touched.join('、'));
  } else {
    bad('D1 删除失败（可能已不存在，看上方输出）');
  }

  console.log('');
  ok('删除完成');
  info('重新部署：node scripts/cli.mjs cf bootstrap && node scripts/cli.mjs cf deploy');
}

