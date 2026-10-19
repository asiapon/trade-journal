/* M2 真实登录 E2E（v2）：wrangler dev(8787, 本地 D1) + vite dev(5173, proxy→8787)
   凭据走环境变量：E2E_USER / E2E_PASS（默认 admin / admin123）。
   TJ_E2E_KEEP=1：复用已在跑的 8787 后端（外部已建库+初始化），否则自起全新实例。 */
import fs from 'node:fs';
import { execSync, spawn } from 'node:child_process';

const TJ = 'C:/lyz/workspace/trade-journal';
const NODE = process.env.NODE_EXE || 'node';
const VITE = TJ + '/node_modules/vite/bin/vite.js';
const WRANGLER = 'C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/wrangler/bin/wrangler.js';
const PERSIST = process.env.TEMP.replace(/\\/g, '/') + '/tj-e2e-d1';
const CDP = 'http://127.0.0.1:9333';
const USER = process.env.E2E_USER || 'admin';
const PASS = process.env.E2E_PASS || 'admin123';
for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY']) delete process.env[k];
process.env.NO_PROXY = '*';

let pass = 0, fail = 0;
const ok = (n, c, g) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + ' → ' + JSON.stringify(g)); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rpc = async (fn, body) => {
  const r = await fetch('http://127.0.0.1:8787/.cloud/database/rest/rpc/' + fn, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: r.status, j: await r.json().catch(() => null) };
};

/* ① 后端就绪 */
let w = null;
const KEEP = process.env.TJ_E2E_KEEP === '1';
if (!KEEP) {
  fs.rmSync(PERSIST, { recursive: true, force: true });
  console.log('—— 启动本地后端（wrangler dev）——');
  w = spawn(NODE, [WRANGLER, 'dev', '--port', '8787', '--local', '--persist-to', PERSIST],
    { cwd: TJ + '/deploy/cloudflare', stdio: 'ignore' });
  process.on('exit', () => { try { w.kill(); } catch (e) { /* */ } });
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try { const h = await (await fetch('http://127.0.0.1:8787/healthz')).json(); if (h.ok && h.d1 === 'up') break; } catch (e) { /* */ }
  }
  execSync(`${NODE} ${WRANGLER} d1 execute trade-journal --local --persist-to ${PERSIST} --file=schema.d1.sql`,
    { cwd: TJ + '/deploy/cloudflare', stdio: 'pipe' });
  const su = await rpc('app_setup_admin', { p_username: USER, p_password: PASS });
  ok('app_setup_admin 成功', su.j && su.j.ok === true, su);
}
{
  const hu = await rpc('app_has_users');
  ok('app_has_users → {ok:true,data:true}', hu.j && hu.j.ok === true && hu.j.data === true, hu);
}

/* 预置一条记录（UI boot 的 loadAll 会读到，查询页可直接渲染） */
{
  const lk = await rpc('app_login', { p_username: USER, p_password: PASS });
  const ins = await rpc('app_insert', { p_token: lk.j.token, p_table: 'trades', p_data: {
    transaction_time: '2026-10-19T01:00:00Z', transaction_type: 'buy', stock_code: '600519',
    stock_name: '贵州茅台', market: 'sh', quantity: 100, price: 1500 } });
  ok('RPC 插入记录', ins.j && ins.j.ok === true, ins.j);
}

try {
  /* ② 起 vite dev（proxy→8787） */
  console.log('—— 启动 vite dev（5173）——');
  const v = spawn(NODE, [VITE, '--port', '5173'], { cwd: TJ, stdio: 'ignore' });
  process.on('exit', () => { try { v.kill(); } catch (e) { /* */ } });
  await sleep(3500);

  /* ③ CDP UI 登录 */
  const t = await (await fetch(CDP + '/json/new?about:blank', { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let id = 0; const wt = new Map(); const errs = [];
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && wt.has(m.id)) { wt.get(m.id)(m); wt.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') errs.push(String((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text).slice(0, 120));
  });
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; wt.set(i, m => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: 'http://localhost:5173/?t=' + Date.now() });
  await sleep(7000);
  const ev = async x => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result.value;
  let st = JSON.parse(await ev(`JSON.stringify({auth:!document.getElementById('authView')?.hidden, mode:(document.getElementById('modeBadge')||{}).textContent})`));
  ok('云端可达 → 显示登录页（非本地模式直进）', st.auth === true, st);

  await ev(`(function(){ document.getElementById('loginUser').value=${JSON.stringify(USER)}; document.getElementById('loginPass').value=${JSON.stringify(PASS)}; })()`);
  await ev(`(function(){ document.getElementById('loginForm').dispatchEvent(new Event('submit', {cancelable:true})); return 'submitted'; })()`);
  await sleep(3000);
  st = JSON.parse(await ev(`JSON.stringify({app:!document.getElementById('appView')?.hidden, user:(document.getElementById('userName')||{}).textContent, mode:(document.getElementById('modeBadge')||{}).textContent})`));
  ok('UI 登录成功进入应用', st.app === true, st);
  ok('用户名 = ' + USER + '（云端模式）', st.user === USER && st.mode === '云端', st);
  ok('整轮无 JS 异常', errs.length === 0, errs.slice(0, 4));

  /* ④ 查询页真实出数据：RPC 插一条 → UI 查询页渲染 */
await ev(`(function(){ document.querySelector('.tab[data-view="trades"]').click(); })()`);
  await sleep(1500);
  const rows = JSON.parse(await ev(`JSON.stringify(document.querySelectorAll('#view-trades tbody tr').length)`));
  ok('查询页渲染出记录行', rows >= 1, rows);

  console.log('\n===== 结果：' + pass + ' 通过 / ' + fail + ' 失败 =====');
} finally {
  try { if (w) w.kill(); } catch (e) { /* */ }
}
process.exit(fail ? 1 : 0);
