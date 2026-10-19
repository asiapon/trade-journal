/* trade-journal v0 外壳冒烟：加载、品牌、导航、零异常 */
for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY']) delete process.env[k];
process.env.NO_PROXY = '*';
const CDP = 'http://127.0.0.1:9333';
let pass = 0, fail = 0;
const ok = (n, c, g) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + ' → ' + JSON.stringify(g)); } };

const t = await (await fetch(CDP + '/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const wt = new Map();
const msgs = [];
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && wt.has(m.id)) { wt.get(m.id)(m); wt.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails || {};
    msgs.push(String((d.exception && (d.exception.description || d.exception.value)) || d.text || 'unknown').slice(0, 150));
  }
  if (m.method === 'Network.loadingFailed' && String(m.params.requestedURL||'') && !String(m.params.requestedURL||'').includes('/.cloud/') && !String(m.params.requestedURL||'').includes('/api/')) msgs.push('NETFAIL ' + (m.params.errorText || '') + ' ' + String(m.params.requestedURL || '').slice(0, 80));
});
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; wt.set(i, m => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
await send('Page.navigate', { url: 'http://localhost:4173/?t=' + Date.now() });
await new Promise(r => setTimeout(r, 9000));
const r0 = await send('Runtime.evaluate', { expression: `JSON.stringify({appVisible:!document.getElementById('appView')?.hidden,user:(document.getElementById('userName')||{}).textContent})`, returnByValue: true });
const d0 = JSON.parse(r0.result.value);
console.log('BOOT:', JSON.stringify(d0));
ok('启动成功：登录页或本地模式进入', d0.appVisible === true, d0);
const r = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    title: document.title,
    authVisible: !document.getElementById('authView')?.hidden,
    h1: (document.querySelector('.auth-logo h1') || {}).textContent,
    brand: (document.querySelector('.topbar-brand') || {}).textContent?.trim(),
    tabs: [...document.querySelectorAll('.tab')].map(x => x.dataset.view),
    bnav: [...document.querySelectorAll('.bnav-item')].map(x => x.dataset.view),
    loginForm: !!document.getElementById('loginForm'),
  })`,
  returnByValue: true,
});
const d = JSON.parse(r.result.value);
console.log('STATE:', JSON.stringify(d));
ok('标题=操作日志', d.title === '操作日志', d.title);
ok('登录页品牌=操作日志', d.h1 === '操作日志', d.h1);
ok('顶栏品牌=操作日志', d.brand === '操作日志', d.brand);
ok('登录表单在', d.loginForm === true);
ok('顶栏导航 5 页（总览/查询/分析/问答/设置）', JSON.stringify(d.tabs) === JSON.stringify(['today', 'trades', 'analysis', 'qa', 'me']), d.tabs);
ok('底部导航 5 页', JSON.stringify(d.bnav) === JSON.stringify(['today', 'trades', 'analysis', 'qa', 'me']), d.bnav);
ok('页面零 JS 异常、零资源加载失败', msgs.length === 0, msgs.slice(0, 6));
if (d0.appVisible) {
  const r2 = await send('Runtime.evaluate', { expression: `(async()=>{ document.querySelector('.tab[data-view=\"trades\"]').click(); const q=document.getElementById('view-trades').classList.contains('active'); document.querySelector('.tab[data-view=\"me\"]').click(); const m=document.getElementById('view-me').classList.contains('active'); const um=!!document.getElementById('userMgmtCard'); document.querySelector('.tab[data-view=\"today\"]').click(); const t=document.getElementById('view-today').classList.contains('active'); return JSON.stringify({q,m,um,t}); })()`, returnByValue: true, awaitPromise: true });
  const dd = JSON.parse(r2.result.value);
  ok('查询/设置/总览 三页可切换', dd.q && dd.m && dd.t, dd);
  ok('设置页含用户管理卡', dd.um === true);
  const r3 = await send('Runtime.evaluate', { expression: `(async()=>{ document.querySelector('.tab[data-view=\"analysis\"]').click(); const a=document.getElementById('view-analysis').classList.contains('active'); const anTabs=[...document.querySelectorAll('#view-analysis .an-tab, #view-analysis [data-anpane]')].length; document.querySelector('.tab[data-view=\"qa\"]').click(); const q=document.getElementById('view-qa').classList.contains('active'); const qaOk=!!document.getElementById('qaMessages'); document.querySelector('.tab[data-view=\"today\"]').click(); return JSON.stringify({a,anTabs,q,qaOk}); })()`, returnByValue: true, awaitPromise: true });
  const d3 = JSON.parse(r3.result.value);
  ok('分析页激活（内部页签 DOM 就位）', d3.a === true && d3.anTabs >= 3, d3);
  ok('问答页激活（消息区就位）', d3.q === true && d3.qaOk === true, d3);
}
console.log('\n===== 结果：' + pass + ' 通过 / ' + fail + ' 失败 =====');
process.exit(fail ? 1 : 0);
