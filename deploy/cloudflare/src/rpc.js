/* ============================================================
   操作日记 · Cloudflare D1 版 RPC 实现（v3.19.0）
   ------------------------------------------------------------
   把 deploy/schema.sql 里 18 个 PG SECURITY DEFINER 函数逐个移植成
   JS + D1，请求/响应契约与 WorkBuddy 云端 / 自托管后端完全一致：
     POST /.cloud/database/rest/rpc/<fn>   body 键 = p_* 命名参数
     响应 = 函数返回值原样 JSON（全部 {ok,...} 信封，app_has_users = {ok,data:boolean}）
   owner_id 隔离 = 每条 SQL 显式 WHERE owner_id = 会话用户（D1 无 RLS）。
   密码 = PBKDF2-SHA256（WebCrypto），替代 pgcrypto bcrypt。
   ============================================================ */
'use strict';

/* ---------- 表结构白名单（列序即 D1 schema，插入/更新按列名定位） ---------- */
const TABLE_COLS = {
  trades: ['owner_id', 'transaction_time', 'transaction_type', 'stock_code', 'stock_name', 'market', 'quantity', 'price', 'gross_amount', 'fee', 'net_amount', 'note', 'source', 'created_at'],
  watchlist: ['owner_id', 'stock_code', 'stock_name', 'group_name', 'note', 'cur_price', 'prev_close', 'starred', 'created_at'],
  quotes: ['owner_id', 'stock_code', 'stock_name', 'price', 'prev_close', 'updated_at'],
  settings: ['owner_id', 'key', 'value', 'updated_at'],
  op_logs: ['owner_id', 'action', 'summary', 'ref_table', 'created_at'],
  qa_history: ['owner_id', 'conversation_id', 'question', 'answer', 'created_at'],
};
const QUERY_TABLES = ['trades', 'watchlist', 'quotes', 'settings', 'op_logs', 'qa_history'];
const WRITE_TABLES = ['trades', 'watchlist', 'quotes', 'settings', 'op_logs'];          // app_update/bulk 口径（PG 版就不含 qa_history）
const BOOL_COLS = new Set(['starred', 'must_change_pwd']);
const JSON_COLS = new Set(['fee', 'value', 'bars']);
/* PG 版 created_at 一律服务端 now()（app_insert 显式剥掉客户端传的 created_at） */
const SERVER_TIME_COLS = new Set(['created_at', 'updated_at']);

const ok = (extra) => Object.assign({ ok: true }, extra || {});
const bad = (msg) => ({ ok: false, msg });

/* ---------- 编解码：JS 值 ↔ D1 列值 ---------- */
function encCol(col, v) {
  if (v === undefined) return null;
  if (v === null) return null;
  if (BOOL_COLS.has(col)) return v ? 1 : 0;
  if (JSON_COLS.has(col)) return JSON.stringify(v == null ? (col === 'bars' ? [] : {}) : v);
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}
function decRow(row) {
  const out = {};
  for (const k of Object.keys(row)) {
    const v = row[k];
    out[k] = BOOL_COLS.has(k) ? !!v : JSON_COLS.has(k) ? safeParse(v) : v;
  }
  return out;
}
function safeParse(s) {
  if (s == null) return s;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch (e) { return s; }
}

/* ---------- 密码：PBKDF2-SHA256（自描述格式，可升迭代数） ---------- */
const PBKDF2_ITER = 100000;
function b64u8(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
function b64decode(s) { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }
async function pbkdf2(password, saltBytes, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' }, key, 256);
  return new Uint8Array(bits);
}
async function hashPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(pw, salt, PBKDF2_ITER);
  return `pbkdf2$${PBKDF2_ITER}$${b64u8(salt)}$${b64u8(hash)}`;
}
async function verifyPassword(pw, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;   // 未知格式（如历史 bcrypt）→ 拒绝
    const iter = Number(parts[1]);
    const hash = await pbkdf2(pw, b64decode(parts[2]), iter);
    const want = b64decode(parts[3]);
    if (hash.length !== want.length) return false;
    let diff = 0;
    for (let i = 0; i < hash.length; i++) diff |= hash[i] ^ want[i];
    return diff === 0;
  } catch (e) { return false; }
}
function newToken() {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('').replace(/\//g, 'x');
}
const nowIso = () => new Date().toISOString();

/* ---------- 会话 ---------- */
async function sessionUser(db, token) {
  if (!token) return null;
  const r = await db.prepare('SELECT username FROM app_sessions WHERE token = ? AND expires_at > ?')
    .bind(String(token), nowIso()).first();
  return r ? r.username : null;
}

/* ---------- 通用错误映射（对齐 PG 版的 exception 分支文案） ---------- */
function insErr(e) {
  const m = String(e && e.message || e);
  if (/UNIQUE/i.test(m)) return bad('记录已存在（重复添加）');
  if (/NOT NULL/i.test(m)) return bad('必填字段缺失');
  return bad('数据校验失败，请检查字段');
}

/* ============================================================
   18 个 RPC 函数（名字/参数/返回与 PG 版一一对应）
   ============================================================ */
const FN = {};

FN.app_has_users = async (db) => {
  const r = await db.prepare('SELECT COUNT(*) AS n FROM app_users').first();
  /* v0.12.3 契约修正：与 WorkBuddy/自托管同形 → {ok,data}（前端 boot 读 probe.ok&&!probe.data
     判定首次初始化；裸 boolean 会让判定静默失效直接落登录页） */
  return { ok: true, data: !!r.n };
};

FN.app_setup_admin = async (db, p) => {
  const u = String(p.p_username || ''), pw = String(p.p_password || '');
  if (u.length < 2 || u.length > 30) return bad('用户名长度需 2-30 个字符');
  if (pw.length < 6) return bad('密码至少 6 位');
  const c = await db.prepare('SELECT COUNT(*) AS n FROM app_users').first();
  if (c.n > 0) return bad('系统已初始化，请联系管理员创建账号');
  await db.prepare('INSERT INTO app_users (username, password_hash, role, must_change_pwd, created_at) VALUES (?,?,?,0,?)')
    .bind(u, await hashPassword(pw), 'admin', nowIso()).run();
  return ok();
};

FN.app_login = async (db, p) => {
  const u = String(p.p_username || ''), pw = String(p.p_password || '');
  await db.prepare('DELETE FROM app_sessions WHERE expires_at < ?').bind(nowIso()).run();
  const row = await db.prepare('SELECT * FROM app_users WHERE username = ?').bind(u).first();
  if (!row || !(await verifyPassword(pw, row.password_hash))) return bad('用户名或密码错误');
  const token = newToken();
  const exp = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  await db.prepare('INSERT INTO app_sessions (token, username, expires_at, created_at) VALUES (?,?,?,?)')
    .bind(token, u, exp, nowIso()).run();
  return ok({ token, username: u, role: row.role, must_change_pwd: !!row.must_change_pwd });
};

FN.app_logout = async (db, p) => {
  await db.prepare('DELETE FROM app_sessions WHERE token = ?').bind(String(p.p_token || '')).run();
  return ok();
};

FN.app_change_pwd = async (db, p) => {
  const pw = String(p.p_new || '');
  if (pw.length < 6) return bad('新密码至少 6 位');
  const row = await db.prepare(
    'SELECT u.username AS uname, u.password_hash AS h FROM app_sessions s JOIN app_users u ON u.username = s.username WHERE s.token = ? AND s.expires_at > ?')
    .bind(String(p.p_token || ''), nowIso()).first();
  if (!row) return bad('未登录或会话已过期');
  if (!(await verifyPassword(String(p.p_old || ''), row.h))) return bad('当前密码不正确');
  await db.prepare('UPDATE app_users SET password_hash = ?, must_change_pwd = 0 WHERE username = ?')
    .bind(await hashPassword(pw), row.uname).run();
  return ok();
};

async function callerRole(db, token) {
  const r = await db.prepare(
    'SELECT u.role AS role FROM app_sessions s JOIN app_users u ON u.username = s.username WHERE s.token = ? AND s.expires_at > ?')
    .bind(String(token || ''), nowIso()).first();
  return r ? r.role : null;
}

FN.app_create_user = async (db, p) => {
  if ((await callerRole(db, p.p_token)) !== 'admin') return bad('仅管理员可创建账号');
  const role = ['admin', 'user'].includes(p.p_role) ? p.p_role : 'user';
  const u = String(p.p_username || ''), pw = String(p.p_password || '');
  if (u.length < 2 || u.length > 30) return bad('用户名长度需 2-30 个字符');
  if (pw.length < 6) return bad('密码至少 6 位');
  try {
    await db.prepare('INSERT INTO app_users (username, password_hash, role, must_change_pwd, created_at) VALUES (?,?,?,1,?)')
      .bind(u, await hashPassword(pw), role, nowIso()).run();
  } catch (e) { return bad('用户名已存在'); }
  return ok();
};

FN.app_delete_user = async (db, p) => {
  const token = String(p.p_token || '');
  if ((await callerRole(db, token)) !== 'admin') return bad('仅管理员可删除账号');
  const target = String(p.p_username || '');
  const self = await db.prepare('SELECT username FROM app_sessions WHERE token = ?').bind(token).first();
  if (target === (self && self.username)) return bad('不能删除当前登录账号');
  const adminCnt = await db.prepare("SELECT COUNT(*) AS n FROM app_users WHERE role = 'admin'").first();
  const isAdmin = await db.prepare("SELECT 1 AS x FROM app_users WHERE username = ? AND role = 'admin'").bind(target).first();
  if (adminCnt.n <= 1 && isAdmin) return bad('至少保留一个管理员');
  /* 与 PG 版逐字对应：业务五表清数据（qa_history 也不删 —— 保持契约一致） */
  for (const t of ['trades', 'watchlist', 'quotes', 'settings', 'op_logs']) {
    await db.prepare(`DELETE FROM ${t} WHERE owner_id = ?`).bind(target).run();
  }
  const r = await db.prepare('DELETE FROM app_users WHERE username = ?').bind(target).run();
  if (!r.meta.changes) return bad('用户不存在');
  return ok();
};

FN.app_list_users = async (db, p) => {
  if ((await callerRole(db, p.p_token)) !== 'admin') return bad('仅管理员可查看用户列表');
  const { results } = await db.prepare('SELECT username, role, must_change_pwd, created_at FROM app_users ORDER BY created_at').all();
  return ok({ data: (results || []).map(r => ({ username: r.username, role: r.role, must_change_pwd: !!r.must_change_pwd, created_at: r.created_at })) });
};

FN.app_reset_pwd = async (db, p) => {
  if ((await callerRole(db, p.p_token)) !== 'admin') return bad('仅管理员可重置密码');
  const pw = String(p.p_new || '');
  if (pw.length < 6) return bad('新密码至少 6 位');
  const r = await db.prepare('UPDATE app_users SET password_hash = ?, must_change_pwd = 1 WHERE username = ?')
    .bind(await hashPassword(pw), String(p.p_username || '')).run();
  if (!r.meta.changes) return bad('用户不存在');
  return ok();
};

FN.app_query = async (db, p) => {
  const uname = await sessionUser(db, p.p_token);
  if (!uname) return bad('未登录或会话已过期');
  const t = String(p.p_table || '');
  if (!QUERY_TABLES.includes(t)) return bad('非法表名');
  const { results } = await db.prepare(`SELECT * FROM ${t} WHERE owner_id = ? ORDER BY id DESC`).bind(uname).all();
  return ok({ data: (results || []).map(decRow) });
};

/* 从 p_data 里取「允许写的列 + 值」（对齐 PG 版 rec = (p_data - id - owner_id - created_at) || {owner_id}） */
function pickCols(table, data, uname) {
  const rec = {};
  for (const col of TABLE_COLS[table]) {
    if (col === 'owner_id') { rec[col] = uname; continue; }
    if (SERVER_TIME_COLS.has(col)) continue;      // 客户端传的也剥掉 → INSERT 时用默认 now
    if (data[col] !== undefined) rec[col] = data[col];
  }
  return rec;
}
/* PG 版 created_at/updated_at 由表 DEFAULT now() 兜底；D1 层在这里补齐（客户端传的已被剥掉） */
function fillServerTimes(table, rec) {
  for (const col of TABLE_COLS[table]) {
    if (SERVER_TIME_COLS.has(col)) rec[col] = nowIso();
  }
  return rec;
}
async function insertRow(db, table, rec) {
  const cols = Object.keys(rec);
  const stmt = db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .bind(...cols.map(c => encCol(c, rec[c])));
  const r = await stmt.run();
  const id = r.meta.last_row_id;
  const row = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first();
  return decRow(row);
}

FN.app_insert = async (db, p) => {
  const uname = await sessionUser(db, p.p_token);
  if (!uname) return bad('未登录或会话已过期');
  const t = String(p.p_table || '');
  if (!QUERY_TABLES.includes(t)) return bad('非法表名');
  const data = p.p_data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return bad('数据格式错误');
  const rec = fillServerTimes(t, pickCols(t, data, uname));
  const effCols = Object.keys(rec).filter(c => rec[c] !== undefined);
  if (!effCols.length) return bad('无有效字段');
  try {
    const row = await insertRow(db, t, rec);
    return ok({ data: row });
  } catch (e) { return insErr(e); }
};

FN.app_update = async (db, p) => {
  const uname = await sessionUser(db, p.p_token);
  if (!uname) return bad('未登录或会话已过期');
  const t = String(p.p_table || '');
  if (!WRITE_TABLES.includes(t)) return bad('非法表名');
  const data = p.p_data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return bad('数据格式错误');
  const id = Number(p.p_id);
  const exist = await db.prepare(`SELECT * FROM ${t} WHERE id = ? AND owner_id = ?`).bind(id, uname).first();
  if (!exist) return bad('记录不存在或无权修改');
  /* 对齐 PG：rec = (现有行 || (p_data - owner_id - id)) - id，owner_id 强制回写本人 */
  const merged = Object.assign({}, exist, data);
  delete merged.id; delete merged.owner_id;
  const cols = Object.keys(merged).filter(c => TABLE_COLS[t].includes(c));
  const sets = cols.map(c => `${c} = ?`).join(', ');
  await db.prepare(`UPDATE ${t} SET ${sets} WHERE id = ? AND owner_id = ?`)
    .bind(...cols.map(c => encCol(c, merged[c])), id, uname).run();
  const row = await db.prepare(`SELECT * FROM ${t} WHERE id = ?`).bind(id).first();
  return ok({ data: decRow(row) });
};

FN.app_delete = async (db, p) => {
  const uname = await sessionUser(db, p.p_token);
  if (!uname) return bad('未登录或会话已过期');
  const t = String(p.p_table || '');
  if (!QUERY_TABLES.includes(t)) return bad('非法表名');
  const r = await db.prepare(`DELETE FROM ${t} WHERE id = ? AND owner_id = ?`)
    .bind(Number(p.p_id), uname).run();
  if (!r.meta.changes) return bad('记录不存在或无权删除');
  return ok();
};

FN.app_bulk_insert = async (db, p) => {
  const uname = await sessionUser(db, p.p_token);
  if (!uname) return bad('未登录或会话已过期');
  const t = String(p.p_table || '');
  if (!WRITE_TABLES.includes(t)) return bad('非法表名');
  const rows = p.p_rows;
  if (!Array.isArray(rows)) return bad('数据格式错误');
  let n = 0;
  for (const el of rows) {
    if (!el || typeof el !== 'object' || Array.isArray(el)) continue;
    const rec = fillServerTimes(t, pickCols(t, el, uname));
    const effCols = Object.keys(rec).filter(c => rec[c] !== undefined);
    if (!effCols.length) continue;
    try {
      await db.prepare(`INSERT INTO ${t} (${effCols.join(',')}) VALUES (${effCols.map(() => '?').join(',')})`)
        .bind(...effCols.map(c => encCol(c, rec[c]))).run();
      n++;
    } catch (e) { /* 对齐 PG：单行失败静默跳过 */ }
  }
  return ok({ count: n });
};

FN.app_bulk_delete = async (db, p) => {
  const uname = await sessionUser(db, p.p_token);
  if (!uname) return bad('未登录或会话已过期');
  const want = Array.isArray(p.p_tables) ? p.p_tables.map(String) : [];
  for (const t of ['trades', 'watchlist', 'quotes', 'op_logs']) {
    if (want.includes(t)) await db.prepare(`DELETE FROM ${t} WHERE owner_id = ?`).bind(uname).run();
  }
  return ok();
};

/* ---------- K 线库（共享参考数据，无 owner 隔离 —— 与 PG 版一致） ---------- */
FN.kline_all = async (db, p) => {
  const uname = await sessionUser(db, p.p_token);
  if (!uname) return bad('未登录或会话已过期');
  const since = p.p_since;
  const { results } = since
    ? await db.prepare('SELECT code, name, bars, days, updated FROM kline_cache WHERE updated >= ?').bind(String(since)).all()
    : await db.prepare('SELECT code, name, bars, days, updated FROM kline_cache').all();
  return ok({ data: (results || []).map(r => ({ code: r.code, name: r.name, bars: safeParse(r.bars) || [], days: r.days, updated: r.updated })) });
};

FN.kline_upsert = async (db, p) => {
  const uname = await sessionUser(db, p.p_token);
  if (!uname) return bad('未登录或会话已过期');
  const rows = p.p_rows;
  if (!Array.isArray(rows)) return bad('数据格式错误');
  let n = 0;
  for (const r of rows) {
    if (!r || typeof r !== 'object' || !/^[0-9]{6}$/.test(String(r.code || ''))) continue;
    const bars = JSON.stringify(Array.isArray(r.bars) ? r.bars : []);
    const days = Number.isFinite(Number(r.days)) ? Number(r.days) : (Array.isArray(r.bars) ? r.bars.length : 0);
    try {
      await db.prepare(
        `INSERT INTO kline_cache (code, name, bars, days, updated, updated_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT(code) DO UPDATE SET name = excluded.name, bars = excluded.bars, days = excluded.days, updated = excluded.updated, updated_at = excluded.updated_at`)
        .bind(String(r.code), r.name == null ? null : String(r.name), bars, days, r.updated ? String(r.updated) : null, nowIso()).run();
      n++;
    } catch (e) { /* 对齐 PG：单行失败跳过 */ }
  }
  return ok({ count: n });
};

FN.kline_status = async (db, p) => {
  const uname = await sessionUser(db, p.p_token);
  if (!uname) return bad('未登录或会话已过期');
  const r = await db.prepare('SELECT COUNT(*) AS count, MAX(updated) AS lastUpdated, COUNT(DISTINCT code) AS codes FROM kline_cache').first();
  return ok({ data: { count: r.count || 0, lastUpdated: r.lastUpdated || null, codes: r.codes || 0 } });
};

FN.kline_stats = async (db, p) => {
  const uname = await sessionUser(db, p.p_token);
  if (!uname) return bad('未登录或会话已过期');
  const tot = await db.prepare('SELECT COUNT(*) AS stocks, COALESCE(SUM(days),0) AS totalBars, MIN(updated) AS first, MAX(updated) AS last FROM kline_cache').first();
  const { results } = await db.prepare(
    'SELECT updated AS d, COUNT(*) AS stocks, COALESCE(SUM(days),0) AS bars FROM kline_cache GROUP BY updated ORDER BY updated DESC LIMIT 90').all();
  return ok({
    data: {
      stocks: tot.stocks || 0, totalBars: tot.totalBars || 0,
      first: tot.first || null, last: tot.last || null,
      daily: (results || []).map(r => ({ d: r.d, stocks: r.stocks, bars: r.bars })),
    },
  });
};

/* ---------- 分发器 ---------- */
const ALLOWED_FN = new Set([
  'app_has_users', 'app_setup_admin', 'app_login', 'app_logout', 'app_change_pwd',
  'app_create_user', 'app_delete_user', 'app_list_users', 'app_reset_pwd',
  'app_query', 'app_insert', 'app_update', 'app_delete', 'app_bulk_insert', 'app_bulk_delete',
  'kline_all', 'kline_upsert', 'kline_status', 'kline_stats',
]);

async function handleRpc(db, fn, body) {
  if (!ALLOWED_FN.has(fn)) return { status: 404, body: bad('未知接口: ' + fn) };
  const f = FN[fn];
  if (!f) return { status: 404, body: bad('未知接口: ' + fn) };
  const params = (body && typeof body === 'object') ? body : {};
  try {
    const r = await f(db, params);
    return { status: 200, body: r };
  } catch (e) {
    return { status: 500, body: bad('数据库错误: ' + (e && e.message || e)) };
  }
}

export { handleRpc, sessionUser, nowIso, ok, bad };
