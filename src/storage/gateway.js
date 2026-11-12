/* 存储网关：三环境（WorkBuddy 云库 / 自托管 PG / CF D1）共用的 RPC 与存储适配
   v0.9.0 自 legacy 拆出：rpc/cloudStore/localStore/loadAll/saveSetting；
   反向依赖（doLogout/syncGroupList）经 sessionHooks/storageHooks 钩子由 app.js 注入。 */
import { S } from '../core/app-state.js';
import { NetLog } from '../core/netlog.js';
import { computePositions, positionRowOf, positionNeedsUpdate } from '../core/holdings.js';

/* v0.14.0 WorkBuddy 云服务（原生 SDK 接入）
   ------------------------------------------------------------
   云服务激活后由平台下发 publicConfig，前端只用 endpoint + publishableKey
   （publishableKey 仅标识应用、本身不带权限，服务端按 Origin 精确校验）。
   注意 endpoint 必须等于应用的发布域名，不可硬编码其它地址，
   否则登录与数据请求会因 Origin 不匹配被服务端拒绝。

   v3.20.1 换应用后更新：旧应用的 wbapp_QlBVRyRFlasNv8qKmoWHMl 已删除，
   域名与 publishableKey 全部失效（表现为「云服务未启用」）。
   现值对应 wbapp_kQybJuiH2NW1ZZKop1t8Wz（2026-10-20 重建）。
   endpoint 在 http(s) 下会被 CLOUD_HOST 用 location.origin 覆盖，
   只有 file:// 兜底时才用到这里的值 —— 但发布域名变了它也要跟着改。 */
export const CLOUD_CONFIG = {
  endpoint: 'https://trade-journal-81772.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_kQybJuiH2NW1ZZKop1t8Wz_k2W7IBwvYl14bP5ypc2ZPdLAZ15109Yz',
};

/* 云库兜底地址：仅在 `file://`（无同源可用）时才会用到。
   注意：页面经 http(s) 直开时一律走同源相对路径，不使用此常量。
   v0.13.1：旧域名 stock-journal-07300 已随项目改名退役（实测 404），
   改为按当前部署域名推导，可用 sj_cloud_host 覆盖。 */
export const CLOUD_HOST = (() => {
  try {
    const custom = String(localStorage.getItem('sj_cloud_host') || '').trim().replace(/\/+$/, '');
    if (custom) return custom;
  } catch (e) { /* */ }
  /* 同源可推导时（http/https）直接用当前 origin；file:// 下回落到云服务 endpoint */
  return (location.protocol === 'http:' || location.protocol === 'https:')
    ? location.origin
    : CLOUD_CONFIG.endpoint;
})();
/* v3.12.0 混合模式：WorkBuddy 托管界面，数据/技能包跑在自己的服务器。
   「后端服务器地址」（设置 → 技能 → 后端服务器地址，存 sj_backend_url）非空时，
   RPC 全部指向它；留空 = 云端数据、同源相对路径，行为与之前完全一致。
   注意：WorkBuddy 页面是 HTTPS，按浏览器混合内容规则，后端地址必须是 HTTPS
   （纯 IP 无法签发受信证书 —— 建议挂一个免费域名 + Caddy 自动证书）。 */
export const BACKEND_URL = (() => {
  try { return String(localStorage.getItem('sj_backend_url') || '').trim().replace(/\/+$/, ''); }
  catch (e) { return ''; }
})();
export const RPC_BASE = (location.protocol === 'file:')
  ? (BACKEND_URL || CLOUD_HOST) + '/.cloud/database/rest/rpc'
  : (BACKEND_URL ? BACKEND_URL + '/.cloud/database/rest/rpc' : '/.cloud/database/rest/rpc');
/* 请求头 x-wb-webapp-access-key 用的 key。
   必须与 CLOUD_CONFIG.publishableKey 一致 —— 它标识应用，
   原来是更早一版的硬编码值，换应用后一直被服务端按 Origin/Key 拒绝。 */
export const ACCESS_KEY = CLOUD_CONFIG.publishableKey;
/* 云端 LLM（免密钥）：模型目录 + 对话调用，与旧版 trade-manager 同一通道 */
export const TABLES = ['trades', 'watchlist', 'quotes', 'settings', 'op_logs', 'qa_history', 'positions'];

/* 会话/装载钩子（app.js 注入，避免存储层反向依赖 UI） */
export const sessionHooks = { onExpired: null };
export const storageHooks = { afterLoad: null };

export async function rpc(fn, params) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${RPC_BASE}/${fn}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-wb-webapp-access-key': ACCESS_KEY },
      body: JSON.stringify(params || {})
    });
    if (r.status === 404 || r.status >= 500) throw new Error('服务不可用(' + r.status + ')');
    const j = await r.json();
    /* v3.9.13 审计：RPC 记参数（脱敏 p_token）与返回；业务失败如实记 FAIL */
    const dbg = Object.assign({}, params || {}); delete dbg.p_token;
    NetLog.push('rpc', fn, !!(j && j.ok), Date.now() - t0, (j && !j.ok) ? (j.msg || '') : '',
      { url: RPC_BASE + '/' + fn, req: JSON.stringify(dbg).slice(0, 280), resp: (j && j.ok) ? ('ok' + (Array.isArray(j.data) ? ` · ${j.data.length} 行` : '')) : '', err: (j && !j.ok) ? (j.msg || '') : '' });
    return j;
  } catch (e) {
    NetLog.push('rpc', fn, false, Date.now() - t0, e.message || String(e), { url: RPC_BASE + '/' + fn, err: e.message || String(e) });
    throw e;
  }
}

/* 云端存储网关（v0.14.1）
   ------------------------------------------------------------
   两种后端并存，按「当前页面是否提供 RPC 端点」自动选择，
   保证同一份 dist 在三种环境都能跑：

   ① RPC 后端（自托管 PG / Cloudflare D1 / 旧云库）
      统一契约 POST /.cloud/database/rest/rpc/<fn>，18 个函数。
      自托管与 CF 都有完整的 app_login / app_query 等实现。
   ② 平台云服务（WorkBuddy Database）
      走 PostgREST（cloud-adapter.js）。仅当页面部署在
      CLOUD_CONFIG.endpoint 域名下、且该环境无 RPC 时启用。

   选择依据放在运行时而非构建期：同一份产物既能上 CF，
   也能上 WorkBuddy 托管，不需要为每个环境单独打包。 */
export { getCloud, resolveSession, clearSessionCache, useCloudService, isCloudServiceEnv, detectBackendKind, cloudAuth } from './cloud-adapter.js';

/* 平台云服务的账号操作（me.js 的「用户管理」页用）。
   注意：这些只对平台云服务后端有效；RPC 后端请走 features/auth.js 的 Auth。 */
export { login, hasUsers, setupAdmin, changePassword, logout, listUsers } from './cloud-adapter.js';

/* RPC 版 cloudStore：自托管 / Cloudflare 使用（与旧实现完全一致） */
export const rpcStore = {
  mode: 'cloud',
  async query(table) {
    const r = await rpc('app_query', { p_token: S.token, p_table: table });
    if (!r.ok) { if (/会话已过期|未登录/.test(r.msg || '')) { if (sessionHooks.onExpired) sessionHooks.onExpired(); } throw new Error(r.msg || '查询失败'); }
    return r.data || [];
  },
  async insert(table, row) {
    const r = await rpc('app_insert', { p_token: S.token, p_table: table, p_data: row });
    if (!r.ok) throw new Error(r.msg || '写入失败');
    return r.data;
  },
  async update(table, id, patch) {
    const r = await rpc('app_update', { p_token: S.token, p_table: table, p_id: id, p_data: patch });
    if (!r.ok) throw new Error(r.msg || '更新失败');
    return r.data;
  },
  async remove(table, id) {
    const r = await rpc('app_delete', { p_token: S.token, p_table: table, p_id: id });
    if (!r.ok) throw new Error(r.msg || '删除失败');
  },
  async bulkInsert(table, rows) {
    const r = await rpc('app_bulk_insert', { p_token: S.token, p_table: table, p_rows: rows });
    return r;
  },
  async clearData(tables) {
    const r = await rpc('app_bulk_delete', { p_token: S.token, p_tables: tables });
    if (!r.ok) throw new Error(r.msg || '清空失败');
  },
  async log(action, summary) {
    try { await this.insert('op_logs', { action, summary }); } catch (e) { /* 日志失败不阻塞 */ }
  },
};

/* 当前生效的云端 store：RPC 后端用 rpcStore；平台云服务用 PostgREST 版。
   由 auth.js 在 boot 时探测决定，避免两套后端混用导致数据分裂。 */
let activeStore = null;
export function setCloudStore(s) { activeStore = s; }
export function getCloudStore() { return activeStore || rpcStore; }
export const cloudStore = {
  get mode() { return 'cloud'; },
  query: (...a) => getCloudStore().query(...a),
  insert: (...a) => getCloudStore().insert(...a),
  update: (...a) => getCloudStore().update(...a),
  remove: (...a) => getCloudStore().remove(...a),
  bulkInsert: (...a) => getCloudStore().bulkInsert(...a),
  clearData: (...a) => getCloudStore().clearData(...a),
  log: (...a) => getCloudStore().log(...a),
};

export const localStore = {
  mode: 'local',
  _read(table) { try { return JSON.parse(localStorage.getItem('sj_' + table) || '[]'); } catch (e) { return []; } },
  _write(table, rows) { localStorage.setItem('sj_' + table, JSON.stringify(rows)); },
  _nextId(rows) { return rows.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1; },
  async query(table) { return this._read(table).sort((a, b) => b.id - a.id); },
  async insert(table, row) {
    const rows = this._read(table);
    const rec = Object.assign({ id: this._nextId(rows), created_at: new Date().toISOString() }, row);
    rows.push(rec); this._write(table, rows);
    return rec;
  },
  async update(table, id, patch) {
    const rows = this._read(table);
    const i = rows.findIndex(r => r.id === id);
    if (i < 0) throw new Error('记录不存在');
    rows[i] = Object.assign({}, rows[i], patch);
    this._write(table, rows);
    return rows[i];
  },
  async remove(table, id) {
    this._write(table, this._read(table).filter(r => r.id !== id));
  },
  async bulkInsert(table, newRows) {
    const rows = this._read(table);
    let n = this._nextId(rows);
    for (const row of newRows) rows.push(Object.assign({ id: n++, created_at: new Date().toISOString() }, row));
    this._write(table, rows);
    return { ok: true, count: newRows.length };
  },
  async clearData(tables) {
    for (const t of tables) { if (TABLES.includes(t)) this._write(t, []); }
  },
  async log(action, summary) {
    try { await this.insert('op_logs', { action, summary }); } catch (e) { /* */ }
  }
};
export let store = null;

/* ============================================================
   AI 模型管理（云端模型目录 + 自定义 OpenAI 兼容模型）
   ============================================================ */

export async function loadAll() {
  const [trades, watchlist, quotes, settings, opLogs] = await Promise.all([
    store.query('trades'), store.query('watchlist'), store.query('quotes'),
    store.query('settings'), store.query('op_logs')
  ]);
  S.trades = trades; S.watchlist = watchlist; S.quotes = quotes; S.opLogs = opLogs;
  S.settings = {}; S._settingRows = {};
  for (const s of settings) { S.settings[s.key] = s.value; S._settingRows[s.key] = s; }
  /* v3.23.2 positions 表：旧 Worker 没有该表白名单时会抛错，降级为渲染层现算 */
  try {
    S.positions = await store.query('positions');
    S.positionsOk = true;
  } catch (e) {
    S.positions = []; S.positionsOk = false;
  }
  if (storageHooks.afterLoad) storageHooks.afterLoad();
  /* v3.23.3 一次性迁移：settings.pos_base → positions.is_base 行
     （base_qty/base_cost 写基线点快照）。只写基线字段，数量/成本等当前值
     紧随其后的全量 syncPositions() 重算回填。迁移失败保留 pos_base 键，下次 boot 再试。 */
  if (S.positionsOk && Array.isArray(S.settings.pos_base) && S.settings.pos_base.length) {
    try {
      await migratePosBase(S.settings.pos_base.filter(b => b && b.stock_code));
      delete S.settings.pos_base;
      const srow = S._settingRows && S._settingRows.pos_base;
      if (srow) { try { await store.remove('settings', srow.id); } catch (e) { /* 键清理失败不影响 */ } delete S._settingRows.pos_base; }
    } catch (e) { /* 迁移失败：保留 pos_base，下次 boot 重试 */ }
  }
  if (S.positionsOk) await syncPositions();
}

/* settings.pos_base 条目 → positions 基线行（upsert 基线字段） */
async function migratePosBase(legacy) {
  const cur = Array.isArray(S.positions) ? S.positions : (S.positions = []);
  const byCode = new Map(cur.map(r => [r.stock_code, r]));
  for (const b of legacy) {
    const qty = Number(b.qty) || 0, cost = Number(b.costPrice) || 0;
    const patch = {
      stock_code: b.stock_code, stock_name: b.stock_name || '', market: b.market || '',
      is_base: 1, base_date: b.base_date || null, base_qty: qty, base_cost: cost
    };
    const row = byCode.get(b.stock_code);
    if (row) { const saved = await store.update('positions', row.id, patch); Object.assign(row, saved); }
    else { const saved = await store.insert('positions', patch); cur.push(saved); byCode.set(b.stock_code, saved); }
  }
}

/* v3.23.3 保存持仓基线（「维护持仓」弹窗入口）：基线直接写 positions 表，
   不再经 settings.pos_base 中转。
   - 表单每行 → upsert is_base=1 行（base_qty/base_cost = 基线点快照）；
   - 表单里删掉的旧基线 → 有流水恢复纯流水推导（is_base 清 0 后增量重算），
     无流水整行删除；
   - 最后对受影响股票增量 syncPositions，重算 qty/cost_price/realized 等当前值。 */
export async function savePosBases(bases) {
  const cur = Array.isArray(S.positions) ? S.positions : (S.positions = []);
  const byCode = new Map(cur.map(r => [r.stock_code, r]));
  const keep = new Set(bases.map(b => b.stock_code));
  const affected = [];
  for (const b of bases) {
    const patch = {
      stock_code: b.stock_code, stock_name: b.stock_name || '', market: b.market || '',
      qty: b.qty, cost_price: b.costPrice, cost_value: b.qty * b.costPrice, diluted_cost: b.qty * b.costPrice,
      realized: 0, realized_op: 0,
      is_base: 1, base_date: b.base_date || null, base_qty: b.qty, base_cost: b.costPrice
    };
    const row = byCode.get(b.stock_code);
    if (row) { const saved = await store.update('positions', row.id, patch); Object.assign(row, saved); }
    else { const saved = await store.insert('positions', patch); cur.push(saved); byCode.set(b.stock_code, saved); }
    affected.push(b.stock_code);
  }
  for (const r of [...cur]) {
    if (!r.is_base || keep.has(r.stock_code)) continue;
    const hasTrades = S.trades.some(t => t.stock_code === r.stock_code);
    if (hasTrades) {
      const saved = await store.update('positions', r.id, { is_base: 0, base_date: null, base_qty: null, base_cost: null });
      Object.assign(r, saved);
      affected.push(r.stock_code);
    } else {
      await store.remove('positions', r.id);
      cur.splice(cur.indexOf(r), 1);
    }
  }
  await syncPositions(affected);
}

/* v3.23.2 持仓表同步引擎：positions 是「当前持仓」的持久化实体——
   每次交易/基线变动后按股票增量重放并 upsert（没有就 INSERT，有就 UPDATE，
   彻底消失——无流水无基线且非今日清仓——则 DELETE）。
   codes 传数组 = 只同步这几只（增量，O(该股流水)）；缺省全量校准。
   同步失败（旧后端无此表）降级：S.positionsOk=false，渲染层回落现算。 */
export async function syncPositions(codes) {
  try {
    /* codes：数组 = 只重放这几只（增量）；空/缺省 = 全量校准 */
    const all = (Array.isArray(codes) && codes.length)
      ? codes.flatMap(c => computePositions(c))
      : computePositions();
    const cur = Array.isArray(S.positions) ? S.positions : (S.positions = []);
    const byCode = new Map(cur.map(r => [r.stock_code, r]));
    const seen = new Set();
    for (const h of all) {
      seen.add(h.code);
      const rec = positionRowOf(h);
      const row = byCode.get(h.code);
      if (!row) {
        const saved = await store.insert('positions', rec);
        cur.push(saved);
      } else if (positionNeedsUpdate(row, rec)) {
        const saved = await store.update('positions', row.id, rec);
        Object.assign(row, saved);
      }
    }
    if (!codes) {
      for (const r of [...cur]) {
        if (!seen.has(r.stock_code)) {
          await store.remove('positions', r.id);
          cur.splice(cur.indexOf(r), 1);
        }
      }
    }
    S.positionsOk = true;
  } catch (e) {
    S.positionsOk = false;
  }
}

/* 设置项 upsert */
export async function saveSetting(key, value) {
  const row = S._settingRows && S._settingRows[key];
  if (row) await store.update('settings', row.id, { value });
  else {
    const rec = await store.insert('settings', { key, value });
    S._settingRows = S._settingRows || {};
    S._settingRows[key] = rec;
  }
  S.settings[key] = value;
}


export function setStore(s) { store = s; }
