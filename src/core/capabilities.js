/* 环境能力自动探测（M3 capabilities）
   ① 受控后端（CF Worker / 新版自托管）提供 /api/capabilities 自报；
   ② 探测不到时按环境兜底推断：WorkBuddy 静态托管 = 无服务端能力；
      未知自托管 → 探 /api/pack/list（Python 技能）与 /api/logs/tail（日志，须 JSON）。
   结果缓存 localStorage 10 分钟（键随后端 base 变化）。 */
import { CLOUD_CONFIG } from '../storage/gateway.js';

const CAPS_KEY = 'sj_caps_v1';
const RPC_TAIL = '/.cloud/database/rest/rpc';

export function backendBase() {
  try {
    const be = String(localStorage.getItem('sj_backend_url') || '').trim().replace(/\/+$/, '');
    if (location.protocol === 'file:') return (be || CLOUD_CONFIG.endpoint);
    return be || '';
  } catch (e) { return ''; }
}

const DEFAULTS = { env: 'unknown', serverLogs: false, packExec: false, asr: false, asrTencent: false, syncCron: false };

function presetByOrigin() {
  if (location.protocol === 'file:' || location.hostname.endsWith('workbuddy.host')) {
    return Object.assign({}, DEFAULTS, { env: 'workbuddy', serverLogs: false });
  }
  return Object.assign({}, DEFAULTS, { env: 'unknown' });
}

async function probeEndpoint(base) {
  const r = await fetch(base + '/api/capabilities', { signal: AbortSignal.timeout(3000) });
  const ct = r.headers.get('content-type') || '';
  if (!r.ok || !ct.includes('json')) throw new Error('无能力端点');
  const j = await r.json();
  if (!j || j.ok !== true) throw new Error('能力端点返回异常');
  return {
    env: j.env || 'unknown',
    serverLogs: !!j.serverLogs,
    packExec: !!j.packExec,
    asr: !!j.asr,
    asrTencent: !!j.asrTencent,
    syncCron: !!j.syncCron,
  };
}

/* 旧版自托管无能力端点 → 逐项探测推断 */
async function probeLegacy(base) {
  const caps = Object.assign({}, DEFAULTS, { env: 'selfhost-legacy' });
  try {
    const r = await fetch(base + '/api/pack/list', { signal: AbortSignal.timeout(3000) });
    if (r.ok && (r.headers.get('content-type') || '').includes('json')) {
      const j = await r.json();
      if (j && j.ok) caps.packExec = true;
    }
  } catch (e) { /* */ }
  try {
    const r = await fetch(base + '/api/logs/tail?n=1', { signal: AbortSignal.timeout(3000), headers: { 'x-sj-token': localStorage.getItem('sj_token') || '' } });
    if (r.status !== 404 && (r.headers.get('content-type') || '').includes('json')) caps.serverLogs = true;
  } catch (e) { /* */ }
  caps.env = (caps.packExec || caps.serverLogs) ? 'selfhost-legacy' : 'unknown';
  return caps;
}

export async function detectCapabilities(force) {
  const base = backendBase();
  const key = base || 'same-origin';
  try {
    const c = JSON.parse(localStorage.getItem(CAPS_KEY) || 'null');
    if (!force && c && c.base === key && Date.now() - c.at < 10 * 60 * 1000) return c.caps;
  } catch (e) { /* */ }

  let caps = null;
  try { caps = await probeEndpoint(base); } catch (e) { /* 无端点 */ }
  if (!caps) caps = await probeLegacy(base);
  if (!caps.serverLogs && !caps.packExec) {
    const preset = presetByOrigin();
    if (preset.env === 'workbuddy') caps = preset;       // 静态托管：确认无服务端能力
  }
  try { localStorage.setItem(CAPS_KEY, JSON.stringify({ base: key, at: Date.now(), caps })); } catch (e) { /* */ }
  return caps;
}

/* 设置页「环境能力」胶囊面板（数据管理卡顶部，自动随探测结果渲染） */
export function renderCapBar(caps, mountId) {
  const el = document.getElementById(mountId || 'capBar');
  if (!el) return;
  const pill = (txt, cls) => `<span class="cap-pill ${cls}">${txt}</span>`;
  const envName = { workbuddy: 'WorkBuddy 云端', cloudflare: 'Cloudflare', 'selfhost-legacy': '自托管（旧版后端）', selfhost: '自托管', unknown: '未识别后端' }[caps.env] || caps.env;
  let html = pill('环境：' + envName, 'cap-ok');
  html += pill('服务端日志 ' + (caps.serverLogs ? '✅' : '❌ 前端日志'), caps.serverLogs ? 'cap-ok' : 'cap-no');
  html += pill('Python 技能包 ' + (caps.packExec ? '✅' : '❌ 需自托管'), caps.packExec ? 'cap-ok' : 'cap-no');
  html += pill('ASR 代理 ' + (caps.asr ? '✅' : (caps.asrTencent ? '✅（Key 走前端）' : '❌')), caps.asr || caps.asrTencent ? 'cap-ok' : 'cap-no');
  html += pill('定时采集 ' + (caps.syncCron ? '✅' : '❌ 打开应用时增量'), caps.syncCron ? 'cap-ok' : 'cap-no');
  el.innerHTML = html;
}
