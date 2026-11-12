/* ============================================================
   scripts/cf/bootstrap.mjs —— 首次初始化 Cloudflare 资源
   ------------------------------------------------------------
   做三件事（幂等，可重复跑）：
     1. 查/建 D1 数据库
     2. 把 database_id 同步写进两份 wrangler.toml
     3. 远端执行 schema.d1.sql 建表
   ============================================================ */
import { DB_NAME, ensureCreds, wrangler, wranglerCapture, extractJson } from './lib.mjs';
import { readDbId, writeDbId, dbIdMismatch, TOML_CF } from '../lib/paths.mjs';
import { title, step, ok, warn, info, die } from '../lib/ui.mjs';

export async function run() {
  title('Cloudflare · 首次初始化');
  ensureCreds();

  /* ---------- 一致性检查 ---------- */
  const mm = dbIdMismatch();
  if (mm) {
    warn('两份 wrangler.toml 的 database_id 不一致：');
    info('deploy/cloudflare/wrangler.toml = ' + mm.cf);
    info('仓库根 wrangler.toml            = ' + mm.root);
    info('本次会统一为正确的那一个');
  }

  /* ---------- 1. D1 数据库 ---------- */
  step('检查 D1 数据库「' + DB_NAME + '」');
  let id = readDbId(TOML_CF);

  if (id && id !== 'TO_CREATE_ON_FIRST_DEPLOY') {
    ok('配置里已有 database_id = ' + id);
    info('如需重建请先跑 node scripts/cli.mjs cf remove（会删数据）');
  } else {
    const list = wranglerCapture(['d1', 'list', '--json']);
    const arr = extractJson(list.out, 'array');
    const hit = Array.isArray(arr) ? arr.find((x) => x.name === DB_NAME) : null;

    if (hit?.uuid) {
      ok('库已存在：' + hit.uuid);
      id = hit.uuid;
    } else {
      info('库不存在，正在创建…');
      const cr = wrangler(['d1', 'create', DB_NAME]);
      const m = (cr.stdout || '').match(/database_id\s*=\s*"([0-9a-f-]{36})"/);
      if (!m) die('创建失败（看上方 wrangler 输出）');
      id = m[1];
      ok('已创建：' + id);
    }
    const touched = writeDbId(id);
    ok('database_id 已写入：' + touched.join('、'));
  }

  /* ---------- 2. 远端建表 ---------- */
  step('远端建表（schema.d1.sql，幂等）');
  const r = wrangler(['d1', 'execute', DB_NAME, '--remote', '-y', '--file=schema.d1.sql']);
  /* v3.23.3：schema 末尾的 ALTER TABLE ... ADD COLUMN（base_qty/base_cost）在
     已补过列的库上会报 duplicate column name —— 属正常，建表部分在此之前已全部落地 */
  if (r.status !== 0) {
    const out = (r.stderr || r.stdout || '').toString();
    if (/duplicate column/i.test(out)) {
      ok('表结构已同步（positions 基线列已存在，跳过重复补列）');
    } else {
      warn('建表返回非 0。若报「already exists」属正常（表已存在）');
      info('其他错误请看上方输出');
    }
  } else {
    ok('表结构已同步');
  }

  /* ---------- 收尾 ---------- */
  console.log('');
  ok('初始化完成');
  info('下一步：node scripts/cli.mjs cf deploy   发布站点');
  info('查看状态：node scripts/cli.mjs cf status');
}
