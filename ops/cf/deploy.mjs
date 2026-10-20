/* ============================================================
   ops/cf/deploy.mjs —— 发布到 Cloudflare Workers
   ------------------------------------------------------------
   构建 → 产物校验 → 测试 → wrangler deploy
   ============================================================ */
import { ensureCreds, wrangler } from './lib.mjs';
import { prepare } from '../lib/build.mjs';
import { dbIdMismatch } from '../lib/paths.mjs';
import { title, step, ok, warn, info, die, footer } from '../lib/ui.mjs';

export async function run() {
  title('Cloudflare · 发布');
  ensureCreds();

  const mm = dbIdMismatch();
  if (mm) {
    warn('两份 wrangler.toml 的 database_id 不一致，线上可能连错库：');
    info('deploy/cloudflare/wrangler.toml = ' + mm.cf);
    info('仓库根 wrangler.toml            = ' + mm.root);
    info('建议先跑 ops cf bootstrap 统一');
  }

  prepare();

  step('部署到 Cloudflare Workers');
  const r = wrangler(['deploy', '-c', 'wrangler.toml']);
  if (r.status !== 0) die('部署失败（看上方 wrangler 输出）');

  ok('部署完成');
  footer([
    '地址见上方 wrangler 输出（*.workers.dev）',
    '首次部署若表还没建：ops cf bootstrap',
    '看实时日志：ops cf logs',
    '查部署状态：ops cf status',
  ]);
}
