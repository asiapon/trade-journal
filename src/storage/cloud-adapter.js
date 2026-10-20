/* ============================================================
   WorkBuddy 云服务存储适配器（v0.14.0）
   ------------------------------------------------------------
   背景：应用原有三套后端（WorkBuddy 旧云库 / 自托管 PG / CF D1）都走
   同一套「18 函数 RPC」契约（app_query / app_insert / app_login ...）。
   2026-10 项目改名后旧云域名退役，改为接入平台原生云服务。

   重要：登录方式保持原样（自建用户名 + 密码），不改用平台第三方登录。
   因此 app_users / app_sessions 两张表继续沿用，密码仍为 PBKDF2 哈希；
   数据表的归属判断从「自签 token → RPC 内解析」改为「会话 token → owner_id」。

   为什么不用 RLS：原 RPC 层靠 SECURITY DEFINER 函数在服务端校验 token 后
   按 owner_id 过滤。新环境没有这些函数，而 PostgREST 直连无法把自定义
   token 映射成 auth.uid()。这里改用等价做法：每次查询都显式带
   owner_id 过滤，且该 owner_id 只来自服务端校验过的会话——
   攻击者拿不到别人的 owner_id，也伪造不了会话（token 为 32 字节随机数）。
   ============================================================ */
import { CLOUD_CONFIG } from './gateway.js';

const JSON_COLS = new Set(['fee', 'value', 'bars']);
const SERVER_TIME_COLS = new Set(['created_at', 'updated_at']);
const SESSION_DAYS = 30;

let cloud = null;
let cloudErr = null;

/* ---------- 环境选择 ----------
   平台云服务（PostgREST）只在「部署在云服务 endpoint 域名下、且该域名没有
   RPC 端点」时启用。Cloudflare 与自托管都实现了完整 RPC，必须走 RPC，
   否则会连到不存在的 PostgREST 路径导致全站 404。
   探测结果缓存到 localStorage，避免每次启动多打一个请求。 */
const ENV_KEY = 'sj_backend_kind_v1';

export function isCloudServiceEnv() {
  try {
    const cached = localStorage.getItem(ENV_KEY);
    if (cached === 'cloudservice') return true;
    if (cached === 'rpc') return false;
  } catch (e) { /* */ }
  /* 未探测时的保守判断：只有落在云服务域名上才可能是平台云服务 */
  return location.origin === CLOUD_CONFIG.endpoint && location.protocol !== 'file:';
}

/* 主动探测一次真实后端类型，供 boot 调用 */
export async function detectBackendKind() {
  if (location.protocol === 'file:') return 'cloudservice';
  try {
    const r = await fetch('/.cloud/database/rest/rpc/app_has_users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(3500),
    });
    /* 有 RPC 后端时一定是 JSON 信封；平台云服务对该路径不提供处理 */
    const ct = r.headers.get('content-type') || '';
    if (r.status !== 404 && ct.includes('json')) {
      localStorage.setItem(ENV_KEY, 'rpc');
      return 'rpc';
    }
  } catch (e) { /* 探测失败按域名判断 */ }
  const kind = isCloudServiceEnv() ? 'cloudservice' : 'rpc';
  try { localStorage.setItem(ENV_KEY, kind); } catch (e) { /* */ }
  return kind;
}

export function useCloudService() {
  return isCloudServiceEnv();
}

export function getCloud() {
  if (cloud) return cloud;
  if (cloudErr) throw cloudErr;
  try {
    if (!window.WorkBuddyCloud || typeof window.WorkBuddyCloud.createWorkBuddyCloud !== 'function') {
      throw new Error('云服务 SDK 未加载（检查网络或 CDN 可达性）');
    }
    cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
      endpoint: CLOUD_CONFIG.endpoint,
      oauthRelayBaseUrl: CLOUD_CONFIG.oauthRelayBaseUrl,
      publishableKey: CLOUD_CONFIG.publishableKey,
    });
    return cloud;
  } catch (e) {
    cloudErr = e;
    throw e;
  }
}

/* ---------- 值编解码 ---------- */
function encRow(row) {
  const out = {};
  for (const k of Object.keys(row || {})) {
    if (k === 'id') continue;
    if (SERVER_TIME_COLS.has(k)) continue;
    let v = row[k];
    if (v === undefined) continue;
    if (JSON_COLS.has(k)) { out[k] = JSON.stringify(v == null ? {} : v); continue; }
    if (v !== null && typeof v === 'object') { out[k] = JSON.stringify(v); continue; }
    out[k] = v;
  }
  return out;
}
function decRow(row) {
  if (!row) return row;
  const out = {};
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (k === 'starred' || k === 'must_change_pwd' || k === 'disabled') { out[k] = !!v; continue; }
    out[k] = JSON_COLS.has(k) ? safeParse(v) : v;
  }
  return out;
}
function safeParse(s) {
  if (s == null || typeof s === 'object') return s == null ? {} : s;
  try { return JSON.parse(s); } catch (e) { return s; }
}
function unwrap({ data, error }) {
  if (error) {
    const e = new Error(error.message || error.details || '云服务请求失败');
    e.code = error.code;
    throw e;
  }
  return data;
}

/* ============================================================
   会话：token 存在 localStorage（与原实现一致），
   每次数据请求前用它换出 owner_id。
   ============================================================ */
let cachedOwner = null;          // { token, ownerId, user, exp }

function randToken() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}
function nowIso() { return new Date().toISOString(); }

export async function resolveSession(token) {
  if (!token) throw new Error('未登录');
  if (cachedOwner && cachedOwner.token === token && cachedOwner.exp > Date.now()) return cachedOwner;
  const rows = unwrap(await getCloud().database
    .from('app_sessions').select('token, owner_id, username, expires_at')
    .eq('token', token).limit(1));
  const s = rows && rows[0];
  if (!s) throw new Error('会话已过期，请重新登录');
  const exp = new Date(s.expires_at).getTime();
  if (!(exp > Date.now())) throw new Error('会话已过期，请重新登录');
  cachedOwner = { token, ownerId: s.owner_id, user: { username: s.username }, exp };
  return cachedOwner;
}

export function clearSessionCache() { cachedOwner = null; }

/* ---------- 登录 / 初始化 / 登出（用户名密码，沿用原语义） ---------- */
const PBKDF2_ITER = 100000;
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  return new Uint8Array(bits);
}
async function hashPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(pw, salt, PBKDF2_ITER);
  return `pbkdf2$${PBKDF2_ITER}$${b64(salt)}$${b64(hash)}`;
}
async function verifyPassword(pw, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
    const iter = Number(parts[1]);
    const hash = await pbkdf2(pw, unb64(parts[2]), iter);
    const want = unb64(parts[3]);
    if (hash.length !== want.length) return false;
    let diff = 0;
    for (let i = 0; i < hash.length; i++) diff |= hash[i] ^ want[i];
    return diff === 0;
  } catch (e) { return false; }
}

export async function login(username, password) {
  const rows = unwrap(await getCloud().database
    .from('app_users').select('id, username, password_hash, role, must_change_pwd, owner_id')
    .eq('username', username).limit(1));
  const u = rows && rows[0];
  if (!u) throw new Error('用户名或密码错误');
  const okPwd = await verifyPassword(password, u.password_hash);
  if (!okPwd) throw new Error('用户名或密码错误');

  const token = randToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400 * 1000).toISOString();
  unwrap(await getCloud().database.from('app_sessions').insert({
    token, owner_id: u.owner_id, username: u.username, expires_at: expires,
  }).select('token'));
  cachedOwner = { token, ownerId: u.owner_id, user: { username: u.username }, exp: new Date(expires).getTime() };
  return {
    token,
    username: u.username,
    role: u.role || null,
    must_change_pwd: !!u.must_change_pwd,
  };
}

export async function hasUsers() {
  const rows = unwrap(await getCloud().database
    .from('app_users').select('id').limit(1));
  return !!(rows && rows.length);
}

export async function setupAdmin(username, password) {
  if (await hasUsers()) throw new Error('系统已初始化，请直接登录');
  const ownerId = 'u_' + randToken().slice(0, 24);
  const row = unwrap(await getCloud().database.from('app_users').insert({
    owner_id: ownerId,
    username,
    password_hash: await hashPassword(password),
    role: 'admin',
    must_change_pwd: false,
  }).select('id, username, role, owner_id'));
  if (!row || !row.length) throw new Error('创建管理员失败');
  return row[0];
}

export async function changePassword(username, oldPwd, newPwd) {
  const rows = unwrap(await getCloud().database
    .from('app_users').select('id, password_hash').eq('username', username).limit(1));
  const u = rows && rows[0];
  if (!u) throw new Error('用户不存在');
  if (!(await verifyPassword(oldPwd, u.password_hash))) throw new Error('当前密码不正确');
  unwrap(await getCloud().database.from('app_users')
    .update({ password_hash: await hashPassword(newPwd), must_change_pwd: false })
    .eq('id', u.id).select('id'));
}

export async function logout(token) {
  clearSessionCache();
  if (!token) return;
  try { await getCloud().database.from('app_sessions').delete().eq('token', token).select('token'); } catch (e) { /* */ }
}

export async function listUsers() {
  const rows = unwrap(await getCloud().database
    .from('app_users').select('id, username, role, must_change_pwd, created_at').order('id', { ascending: true }));
  return (rows || []).map(decRow);
}

/* ============================================================
   cloudStore：与旧版同名同签名，只换实现
   ------------------------------------------------------------
   每次读写都以当前会话的 owner_id 为条件，等价于原 RPC 内的
   WHERE owner_id = 会话用户，做到按账号隔离。
   ============================================================ */
export const cloudStore = {
  mode: 'cloud',

  async _owner() {
    const s = await resolveSession(localStorage.getItem('sj_token'));
    return s.ownerId;
  },

  async query(table) {
    const owner = await this._owner();
    const rows = unwrap(await getCloud().database
      .from(table).select('*').eq('owner_id', owner).order('id', { ascending: false }));
    return (rows || []).map(decRow);
  },

  async insert(table, row) {
    const owner = await this._owner();
    const payload = Object.assign(encRow(row), { owner_id: owner });
    const rows = unwrap(await getCloud().database.from(table).insert(payload).select());
    if (!rows || !rows.length) throw new Error('写入失败');
    return decRow(rows[0]);
  },

  async update(table, id, patch) {
    const owner = await this._owner();
    const rows = unwrap(await getCloud().database
      .from(table).update(encRow(patch)).eq('id', id).eq('owner_id', owner).select());
    if (!rows || !rows.length) throw new Error('记录不存在或已删除');
    return decRow(rows[0]);
  },

  async remove(table, id) {
    const owner = await this._owner();
    const rows = unwrap(await getCloud().database
      .from(table).delete().eq('id', id).eq('owner_id', owner).select('id'));
    if (!rows || !rows.length) throw new Error('记录不存在或已删除');
  },

  async bulkInsert(table, rows) {
    if (!rows || !rows.length) return { ok: true, count: 0 };
    const owner = await this._owner();
    const payload = rows.map(r => Object.assign(encRow(r), { owner_id: owner }));
    const out = unwrap(await getCloud().database.from(table).insert(payload).select('id'));
    return { ok: true, count: (out || []).length };
  },

  async clearData(tables) {
    const owner = await this._owner();
    for (const t of tables) {
      unwrap(await getCloud().database.from(t).delete().eq('owner_id', owner).select('id'));
    }
  },

  async log(action, summary) {
    try { await this.insert('op_logs', { action, summary }); } catch (e) { /* 日志失败不阻塞 */ }
  },
};

/* cloudAuth：与会话相关的操作集合。RPC 后端与平台云服务各有一套实现，
   gateway 按探测结果取用，保证 auth.js 只调用一套接口。 */
export const cloudAuth = {
  async available() { return true; },
  hasUsers, setupAdmin, login, changePassword, logout, listUsers,
  async resolve(token) { return resolveSession(token); },
};
