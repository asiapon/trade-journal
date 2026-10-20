/* ============================================================
   ops/cf/logs.mjs —— 查看 Cloudflare Worker 实时日志
   ------------------------------------------------------------
   wrangler tail 是流式的，默认会一直挂着。这里支持两种用法：
     ops cf logs            实时流（Ctrl+C 退出）
     ops cf logs --once     只抓最近一小段就退出（脚本/CI 用）
   ============================================================ */
import { spawn } from 'node:child_process';
import { ensureCreds, wranglerBin, WORKER_NAME } from './lib.mjs';
import { CFDIR } from '../lib/paths.mjs';
import { title, info, warn } from '../lib/ui.mjs';

export async function run(argv = []) {
  title('Cloudflare · 实时日志');
  ensureCreds();

  const once = argv.includes('--once') || argv.includes('-1');
  const args = ['tail', WORKER_NAME, '--format', 'pretty'];
  if (once) args.push('--once');

  info(once ? '抓取最近一小段后退出…' : '实时流模式，Ctrl+C 退出');
  console.log('');

  await new Promise((resolve) => {
    const p = spawn(process.execPath, [wranglerBin(), ...args], {
      cwd: CFDIR,
      stdio: 'inherit',
      env: {
        ...process.env,
        CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
        CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
      },
    });
    p.on('error', (e) => { warn('启动失败：' + e.message); resolve(); });
    p.on('close', (code) => {
      /* wrangler tail 无流量时 --once 可能长时间不返回；Ctrl+C 是正常退出 */
      if (code !== 0 && code !== null && !once) {
        warn(`wrangler 退出码 ${code}`);
      }
      resolve();
    });
  });
}

