/* 设置页域：费率编辑 / 卡片渲染 / 日志视图 / 用户管理数据（v0.11.0 自单体拆出） */
import { renderHealthPanel } from '../ui/health-panel.js';
import { jskillsList, jskillInstallFromUrl, jskillRemove, jskillToggle } from './jskills.js';
import { $, toast, fmt2, fmtP, fmtPct, pnlCls, esc, fmtTime, nowLocalInput, inferMarket, MKT_NAME } from '../shared/utils.js';
import { NetLog, sjTokenHeaders } from '../core/netlog.js';
import { StockDict } from '../core/stockdict.js';
import { DL } from '../core/data-layer.js';
import { emQuote, txQuote } from '../sources/quotes.js';
import { ACCESS_KEY, BACKEND_URL, CLOUD_HOST, RPC_BASE, TABLES, cloudStore, loadAll, localStore, rpc, saveSetting, sessionHooks, setStore, storageHooks, store, listUsers } from '../storage/gateway.js';
import { S } from '../core/app-state.js';
import { Auth } from '../features/auth.js';
import { feeCfg } from './journal.js';

export function renderFeeEditor() {
  const mkts = ['sh', 'sz', 'bse'];
  $('feeEditor').innerHTML = mkts.map(mk => {
    const f = feeCfg(mk);
    const fields = [
      ['rate', '佣金费率 ‰'], ['min', '最低费用 元'],
      ['stamp', '印花税 ‰ (卖出)'], ['transfer', '过户费 ‰'],
      ['handling', '经手费 ‰'], ['gov', '证管费 ‰']
    ];
    return `<div class="fee-mkt">
      <div class="fee-mkt-head">${MKT_NAME[mk] || mk}<span class="hint">最低费用：佣金+规费合计不足该值时按该值收取（印花税除外）</span></div>
      <div class="fee-mkt-grid">
        ${fields.map(([k, label]) => `<label>${label}<input type="number" step="0.001" min="0" data-mkt="${mk}" data-key="${k}" value="${f[k]}"></label>`).join('')}
      </div>
    </div>`;
  }).join('');
}
export async function saveFeeEditor() {
  const cfg = { sh: {}, sz: {}, bse: {} };
  $('feeEditor').querySelectorAll('input[data-mkt]').forEach(inp => {
    cfg[inp.dataset.mkt][inp.dataset.key] = parseFloat(inp.value) || 0;
  });
  await saveSetting('fee', cfg);
  await store.log('settings', '更新费率设置');
  toast('费率已保存');
}
/* v3.8.49 设置页「权限收敛」与页签切换
   普通用户（非管理员）只保留「交易费用」「用户管理（改自己密码）」两项；
   模型 / 数据管理 / 操作日志 对普通用户不显示、也不呈现空面板。 */
export function switchSetPane(name) {
  document.querySelectorAll('#setTabs .set-tab').forEach(x => x.classList.toggle('active', x.dataset.set === name));
  document.querySelectorAll('#view-me .set-pane').forEach(p => { p.hidden = p.dataset.pane !== name; });
  /* v3.9.9 每次切到技能页都重渲染：Key / 技能开关可能在别处（问答页提示条）刚变过 */
  if (name === 'skill') renderSkillCenter();
}
function renderJsSkills() {
  const box = document.getElementById('jskillList');
  if (!box) return;
  const list = jskillsList();
  box.innerHTML = list.length ? list.map(s =>
    '<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:0.5px solid var(--line,#d8d6cd)">'
    + '<label style="display:flex;align-items:center;gap:4px;flex:1;min-width:0">'
    + '<input type="checkbox" data-jskill-toggle="' + esc(s.id) + '"' + (s.enabled !== false ? ' checked' : '') + '>'
    + '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><b>' + esc(s.name) + '</b> <span class="hint">v' + esc(s.version) + ' · '
    + s.tools.length + ' 工具 · ' + esc(s.id) + '</span></span></label>'
    + '<button class="btn ghost sm" data-jskill-del="' + esc(s.id) + '" type="button">删</button></div>'
  ).join('') : '<p class="hint">尚未安装 JS 技能。示例格式见 deploy/DEPLOY.md「JS 技能包」一节。</p>';
}

export function renderMe() {
  renderFeeEditor();
  renderLogs();
  renderNetLogUI();
  renderHealthPanel('dlHealth');
  renderJsSkills();
  const cloud = S.mode === 'cloud' && !!S.user;
  /* v3.9.20 本地模式 = 单用户自托管，使用者就是 owner。
     旧实现把 admin 绑死成 `cloud && role==='admin'`，本地模式因此把
     模型 / 数据管理 / 技能 / 操作日志 四个页签全部隐藏 ——
     连「数据管理 → 静态数据中心」都进不去。这里对本地模式直接放行。 */
  const localOwner = S.mode === 'local';
  const admin = localOwner || !!(cloud && S.user.role === 'admin');
  const isAdminPane = n => n !== 'cost' && n !== 'user';
  document.querySelectorAll('#setTabs .set-tab').forEach(t => { t.hidden = isAdminPane(t.dataset.set) && !admin; });
  if (!admin) document.querySelectorAll('#view-me .set-pane').forEach(p => { if (isAdminPane(p.dataset.pane)) p.hidden = true; });
  /* 当前停留的页签被隐藏了（普通用户默认落在「模型」）→ 落到第一个可见页签 */
  const act = document.querySelector('#setTabs .set-tab.active');
  if (!act || act.hidden) {
    const first = document.querySelector('#setTabs .set-tab:not([hidden])');
    if (first) switchSetPane(first.dataset.set);
  }
  const acct = $('myAcctCard');
  if (acct) acct.hidden = !cloud;
  const ah = $('myAcctHint');
  if (ah) ah.textContent = cloud ? `当前账号 ${S.user.username}${admin ? '（管理员）' : ''}` : '—';
  $('userMgmtCard').hidden = !(cloud && S.user && S.user.role === 'admin');
  /* v3.9.20 本地模式：用户管理页签下给一句说明，而不是整片空白 */
  const lc = $('userLocalCard');
  if (lc) lc.hidden = !localOwner;
  if (admin && cloud) loadUsers();
}
/* ---------- v3.12.4 日志页：自托管只读服务器日志文件；
   v3.18.1 云端托管版没有服务端进程（纯静态托管+云数据库，无磁盘可写），
   生成不了服务端日志文件 → 改为显示前端本机日志（NetLog.buf，localStorage 持久化
   最近 200 条），「下载」由浏览器 Blob 本地生成 .log 文件，不再需要服务端。 ---------- */
export function netLogLine(e) {
  const hm = (e.t || '').replace('T', ' ').slice(5, 19);          // MM-DD HH:MM:SS
  return hm + ' [' + (e.ok ? 'OK' : 'FAIL') + '] ' + e.kind + ' ' + e.name + ' ' + (e.ms || 0) + 'ms'
    + (e.src ? ' ｜ ' + e.src : '')
    + (e.ok ? (' ｜ ' + (e.resp || e.detail || '')) : (' ｜ ' + (e.err || e.detail || '')));
}
/* 日志页自动刷新定时器（模块级；重复进入页面时重建，避免堆积） */
let _netLogTimer = null;
let _lastLogTxt = '';

export function renderNetLogUI() {
  const el = $('netLogSummary');
  if (!el) return;
  const list = $('netLogList');
  /* v0.4.0 能力化：探测到 serverLogs（自托管/CF D1）走服务端日志，否则前端日志 */
  const caps = window.__CAPS;
  const isSelf = caps ? caps.serverLogs : (!(location.hostname.endsWith('workbuddy.host')) && location.protocol !== 'file:');

  const draw = () => {
    if (!isSelf) {
      const buf = (typeof NetLog !== 'undefined' && NetLog.buf) || [];
      el.textContent = '云端托管版没有服务端日志文件（纯静态托管，无可写磁盘）；以下是本机浏览器记录的前端调用日志（最近 ' + buf.length + ' 条，存本机）。';
      if (list) {
        list.innerHTML = buf.length
          ? '<pre class="srv-log">' + esc(buf.map(netLogLine).join('\n')) + '</pre>'
          : '<p class="hint">本机还没有调用记录（打开行情/问答等会自动记录）。</p>';
      }
      return;
    }
    el.textContent = '日志文件：deploy/selfhost/logs/app-' + new Date().toISOString().slice(0, 10) + '.log'
      + '（调用后 2.5 秒批量上报一次；本页每 5 秒自动刷新）';
    fetch('/api/logs/tail?n=200', { headers: sjTokenHeaders() }).then(r => r.json()).then(j => {
      const txt = (j.lines || []).join('\n') || '(空)';
      if (!list || txt === _lastLogTxt) return;      // 内容没变不重建，免得滚动位置被顶回顶部
      _lastLogTxt = txt;
      list.innerHTML = '<pre class="srv-log">' + esc(txt) + '</pre>';
    }).catch(e => { if (list && !list.querySelector('pre')) list.textContent = '读取失败：' + (e.message || e); });
  };

  draw();

  /* 自动刷新的原因：日志是「调用后 2.5 秒才批量上报」的。原来只在打开页面时读一次，
     点完一键分析立刻进来，看不到刚发生的调用，于是误以为「根本没记日志」。 */
  if (_netLogTimer) { clearInterval(_netLogTimer); _netLogTimer = null; }
  _netLogTimer = setInterval(() => {
    if (!document.body.contains(el)) { clearInterval(_netLogTimer); _netLogTimer = null; return; }
    if (el.offsetParent === null) return;          // 页签不可见，不刷
    draw();
  }, 5000);
}
/* ---------- 费率编辑 ---------- */
export function renderLogs() {
  const logs = S.opLogs.slice(0, 20);
  $('logList').innerHTML = logs.length ? logs.map(l => `<div class="mini-item">
    <div class="mini-main">
      <div class="mini-title">${esc(l.action)}</div>
      <div class="mini-sub">${esc(l.summary || '')}</div>
    </div>
    <div class="mini-right"><div class="m-sub">${fmtTime(l.created_at, true)}</div></div>
  </div>`).join('') : '<div class="empty">暂无日志</div>';
}
export async function loadUsers() {
  try {
    const rows = await Auth.listUsers();
    if (!rows) return;
    $('userTable').querySelector('tbody').innerHTML = rows.map(u => `<tr>
      <td>${esc(u.username)}</td>
      <td>${u.role === 'admin' ? '<span class="tag">管理员</span>' : '<span class="tag" style="background:var(--bg);color:var(--ink-2)">用户</span>'}</td>
      <td>${fmtTime(u.created_at, true)}</td>
      <td><div class="row-actions">
        <button class="icon-btn reset-user" data-u="${esc(u.username)}">重置密码</button>
        <button class="icon-btn del del-user" data-u="${esc(u.username)}">删除</button>
      </div></td>
    </tr>`).join('');
  } catch (e) { /* 静默 */ }
}

/* ============================================================
   事件绑定
   ============================================================ */

/* ---- JS 技能包交互（事件委托，绑定一次） ---- */
document.addEventListener('click', async e => {
  const add = e.target.closest('#jskillAddBtn');
  if (add) {
    const input = document.getElementById('jskillUrl');
    const msg = document.getElementById('jskillMsg');
    const url = (input && input.value || '').trim();
    if (!url) { if (msg) msg.textContent = '请先填写 SKILL.json 地址'; return; }
    if (msg) msg.textContent = '⏳ 正在下载并校验…';
    try {
      const pkg = await jskillInstallFromUrl(url);
      if (msg) msg.textContent = '✅ 已安装「' + pkg.name + '」（' + pkg.tools.length + ' 个工具），问答里即可使用';
      if (input) input.value = '';
      renderJsSkills();
    } catch (err) { if (msg) msg.textContent = '❌ 安装失败：' + (err.message || err); }
    return;
  }
  const del = e.target.closest('[data-jskill-del]');
  if (del) { jskillRemove(del.dataset.jskillDel); renderJsSkills(); return; }
});
document.addEventListener('change', e => {
  const t = e.target.closest('[data-jskill-toggle]');
  if (t) { jskillToggle(t.dataset.jskillToggle, t.checked); renderJsSkills(); }
});
