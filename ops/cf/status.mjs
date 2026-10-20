/* ============================================================
   ops/cf/status.mjs —— 查看 Cloudflare 部署状态
   ------------------------------------------------------------
   走 REST API 而非解析 wrangler 文本输出，字段稳定好判断。
   查：Worker 是否已部署 / 最后修改时间 / D1 库 / 表清单与行数
   ============================================================ */
import { cfApi, ensureCreds, WORKER_NAME, DB_NAME } from './lib.mjs';
import { dbIdMismatch, DIST, exists } from '../lib/paths.mjs';
import { distSummary, humanSize } from '../lib/build.mjs';
import { title, step, ok, warn, info, bad, kv, C } from '../lib/ui.mjs';

const TABLES = ['trades', 'watchlist', 'quotes', 'settings', 'op_logs', 'qa_history', 'app_users', 'app_sessions'];

export async function run() {
  title('Cloudflare · 状态');
  ensureCreds();

  /* ---------- 本地配置 ---------- */
  step('本地配置');
  const mm = dbIdMismatch();
  kv([
    ['Worker 名', WORKER_NAME],
    ['D1 库名', DB_NAME],
    ['database_id 一致性', mm ? C.y('不一致（先跑 ops cf bootstrap）') : C.g('一致')],
  ]);
  if (mm) {
    info('  deploy 侧 = ' + mm.cf);
    info('  根目录侧 = ' + mm.root);
  }

  const ds = distSummary();
  if (ds) kv([['本地 dist', `${ds.files} 文件 / ${humanSize(ds.bytes)} / ${ds.mtime.toLocaleString('zh-CN')}`]]);
  else if (exists(DIST)) kv([['本地 dist', '存在但读不到 index.html']]);
  else kv([['本地 dist', C.d('未构建（跑 ops cf deploy 会自动构建）')]]);

  /* ---------- Worker ---------- */
  step('Worker 部署');
  const w = await cfApi(`/workers/scripts/${WORKER_NAME}`);
  if (w.ok) {
    const d = w.data || {};
    const mod = d.modified_on ? new Date(d.modified_on).toLocaleString('zh-CN') : '未知';
    ok('已部署');
    kv([['最后修改', mod], ['脚本大小', d.size ? humanSize(d.size) : '未知']]);

    /* 取子域地址 */
    const sub = await cfApi('/workers/subdomain');
    if (sub.ok && sub.data?.subdomain) {
      kv([['访问地址', C.b(`https://${WORKER_NAME}.${sub.data.subdomain}.workers.dev`)]]);
    }
  } else {
    bad('未部署或凭据无权访问：' + w.error);
    info('首次发布：ops cf bootstrap && ops cf deploy');
    return;
  }

  /* ---------- D1 ---------- */
  step('D1 数据库');
  const dbs = await cfApi('/d1/database');
  if (!dbs.ok) {
    warn('查不到 D1 列表：' + dbs.error);
    return;
  }
  const db = (dbs.data || []).find((x) => x.name === DB_NAME);
  if (!db) {
    bad(`库「${DB_NAME}」不存在`);
    info('运行 ops cf bootstrap 创建');
    return;
  }
  ok('库存在：' + db.uuid);
  kv([['创建时间', db.created_at ? new Date(db.created_at).toLocaleString('zh-CN') : '未知']]);

  /* ---------- 表与行数 ---------- */
  step('表与数据量');
  const q = await cfApiQuery(db.uuid, `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`);
  if (!q.ok) {
    warn('查表失败：' + q.error);
    return;
  }
  const names = (q.rows || []).map((r) => r.name);
  if (!names.length) {
    warn('库里还没有表');
    info('运行 ops cf bootstrap 建表');
    return;
  }

  const rows = [];
  for (const t of names) {
    const c = await cfApiQuery(db.uuid, `SELECT COUNT(*) AS n FROM "${t}"`);
    rows.push([t, c.ok ? String((c.rows?.[0] || {}).n ?? '?') : C.y('查询失败')]);
  }
  kv(rows);

  const missing = TABLES.filter((t) => !names.includes(t));
  if (missing.length) {
    warn('缺少预期表：' + missing.join(', ') + '（跑 ops cf bootstrap）');
  } else {
    ok('8 张业务表齐全');
  }

  /* ---------- 健康探测 ---------- */
  step('远端接口探测');
  const sub2 = await cfApi('/workers/subdomain');
  if (sub2.ok && sub2.data?.subdomain) {
    const base = `https://${WORKER_NAME}.${sub2.data.subdomain}.workers.dev`;
    try {
      const r = await fetch(`${base}/.cloud/database/rest/rpc/app_has_users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(10000),
      });
      const ct = r.headers.get('content-type') || '';
      if (r.ok && ct.includes('json')) {
        const j = await r.json().catch(() => null);
        ok(`RPC 端点可用（HTTP ${r.status}，has_users=${j?.has_users ?? j?.ok ?? '?'}）`);
      } else {
        warn(`RPC 端点返回 HTTP ${r.status}（非 JSON：${ct || '无 content-type'}）`);
        info('站点可能是静态托管或 Worker 未绑定 D1');
      }
    } catch (e) {
      warn('RPC 探测失败：' + e.message);
    }
  }
}

/** D1 HTTP 查询接口 */
async function cfApiQuery(dbUuid, sql) {
  const acc = process.env.CLOUDFLARE_ACCOUNT_ID;
  const tok = process.env.CLOUDFLARE_API_TOKEN;
  try {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acc}/d1/database/${dbUuid}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json();
    if (!j.success) {
      return { ok: false, error: (j.errors || []).map((e) => e.message).join('; ') || `HTTP ${r.status}` };
    }
    const first = Array.isArray(j.result) ? j.result[0] : j.result;
    return { ok: true, rows: first?.results || [] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
