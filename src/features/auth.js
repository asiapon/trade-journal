/* 认证与会话（自 legacy 拆出）：boot / 登录 / 进入应用。
   与 app.js 存在循环 import（enterApp 调渲染层、app.js 调 boot）——
   ESM live binding 下函数提升 + 运行时调用，安全。 */
import { rpc, loadAll, BACKEND_URL, setStore, cloudStore, localStore } from '../storage/gateway.js';
import { S } from '../core/app-state.js';
import { $, toast, nowLocalInput } from '../shared/utils.js';
import { StockDict } from '../core/stockdict.js';
import { renderAll, ensureCloudLlm, ModelMgr, refreshQuotes, initQa, renderQaMessages, renderQaHistory, qaSyncSendState, qaBoot, bindEvents, switchView } from '../app.js';

export async function boot() {
  bindEvents();
  /* 恢复上次所在页面 */
  try {
    const last = localStorage.getItem('sj_view');
    if (last && $('view-' + last)) switchView(last);
  } catch (e) { /* */ }
  $('tfTime').value = nowLocalInput();
  try {
    const probe = await Promise.race([
      rpc('app_has_users'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))
    ]);
    setStore(cloudStore); S.mode = 'cloud';
    if (probe && probe.ok && !probe.data) {
      // 首次使用：显示初始化
      $('tabInit').hidden = false;
      $('tabInit').click();
      showAuth(); return;
    }
    // 已有会话则直接进入
    const saved = JSON.parse(localStorage.getItem('sj_user') || 'null');
    if (saved && localStorage.getItem('sj_token')) {
      S.token = localStorage.getItem('sj_token'); S.user = saved;
      try { await enterApp(); return; } catch (e) { /* 会话失效走登录 */ }
    }
    showAuth();
  } catch (e) {
    // 云端不可达 → 本地模式
    setStore(localStore); S.mode = 'local';
    enterApp({ username: '本地用户', role: null, local: true });
  }
}
export function showAuth() {
  $('authView').hidden = false;
  $('appView').hidden = true;
  // 页签条仅在有"初始化"场景（尚无账号）时显示，避免与登录按钮形成两个"登录"
  $('authTabs').hidden = $('tabInit').hidden;
}

/* ============================================================
   v3.8.57 登录页键盘防遮挡——纯 CSS 静态方案（零 JS）
   ------------------------------------------------------------
   历史：
     v3.8.54 监听 visualViewport + 每次聚焦重算可视高度 + 动态位移，
             把卡片顶到键盘之上。实测体验差——输用户名时卡片中途挪动、
             再点密码框又跳一次，用户反馈「不能简单点吗，进入时就偏上一点」。
   现方案：完全不绑事件、不做任何位移，登录卡仍是 flex 居中，
           只在 `.auth-wrap` 底部加空白（padding-bottom）把内容整体上抬，
           见 style.css（默认上移 20vh，矮屏分档到 26vh / 30vh）。
   为什么可行：flex `align-items:center` 的参照点是「上内距底 ~ 下内距顶」
           的中点，底部内距加厚 2X 就等于内容整体上移 X。
   为什么不位移：transform / scroll 类动态方案在输入框之间切换时会跳，
           且受滚动锚定干扰；纯静态布局全程恒定，实测 focus/blur 后
           卡片位置一个像素都不动。
   ============================================================ */

export async function doLogin(username, password) {
  const r = await rpc('app_login', { p_username: username, p_password: password });
  if (!r.ok) throw new Error(r.msg || '登录失败');
  S.token = r.token;
  S.user = { username: r.username, role: r.role, must_change_pwd: r.must_change_pwd };
  localStorage.setItem('sj_token', r.token);
  localStorage.setItem('sj_user', JSON.stringify(S.user));
  if (r.must_change_pwd) {
    switchAuthForm('forcePwdForm');
    $('forcePwdHint').textContent = `账号 ${r.username} 为初始密码，请修改后再进入。`;
    showAuth(); return;
  }
  await enterApp();
}
export async function doLogout(silent) {
  if (!silent && S.token) { try { await rpc('app_logout', { p_token: S.token }); } catch (e) { /* */ } }
  localStorage.removeItem('sj_token');
  localStorage.removeItem('sj_user');
  if (silent) { showAuth(); switchAuthForm('loginForm'); return; }
  location.reload();
}
async function enterApp(user) {
  if (user) S.user = user;
  $('authView').hidden = true;
  $('appView').hidden = false;
  /* v3.12.4 顶栏显示当前连接的后端地址（自托管=本机/域名；混合模式=填的地址；云端托管=WorkBuddy 云） */
  const bb = $('backendBadge');
  if (bb) {
    if (BACKEND_URL) { bb.textContent = '后端 ' + BACKEND_URL.replace(/^https?:\/\//, ''); bb.title = '当前连接的后端服务器：' + BACKEND_URL + '（设置 → 技能 → 后端服务器地址 可切换）'; }
    else if (location.hostname.endsWith('workbuddy.host')) { bb.textContent = 'WorkBuddy 云端'; bb.title = '数据存 WorkBuddy 云数据库；如需切换到自托管服务器，到 设置 → 技能 → 后端服务器地址 填地址'; }
    else { bb.textContent = '后端 ' + (location.host || '本机'); bb.title = '当前连接的后端服务器：' + location.host; }
  }
  if (S.mode === 'cloud') {
    $('modeBadge').textContent = '云端';
    $('modeBadge').classList.remove('local');
    $('userName').textContent = S.user.username;
    $('userRole').hidden = S.user.role !== 'admin';
    $('logoutBtn').hidden = false;
  } else {
    $('modeBadge').textContent = '本地';
    $('modeBadge').classList.add('local');
    $('userName').textContent = '本地模式';
    $('userRole').hidden = true;
    $('logoutBtn').hidden = true;
  }
  $('aboutStorage').textContent = S.mode === 'cloud'
    ? '数据存储：WorkBuddy 云数据库（按账号隔离，跨设备同步）'
    : '数据存储：浏览器 localStorage（仅本机，请定期导出备份）';
  await loadAll();
  /* 模型初始化：先同步云端配置 → 缓存渲染 → 后台刷新目录（云端为权威，同 trade-manager）
     v3.15.2 每一步独立容错 —— 此前 initCloudLlm 在自托管域名抛错会让整个模型初始化中断，
     徽章永远停在 HTML 默认的「未配置」（设置页里模型明明已添加/选中）。 */
  ensureCloudLlm();
  ModelMgr.loadCache(); ModelMgr.loadCustom();
  try { ModelMgr.applyCloudConfig(); } catch (e) { console.warn('[model] 云端配置合并失败', e); }
  try { ModelMgr.loadCur(); } catch (e) { console.warn('[model] 当前模型恢复失败', e); }
  try { ModelMgr.render(); } catch (e) { console.warn('[model] 渲染失败', e); }
  /* v3.9.0 智能问答初始化：必须在 loadAll 之后 —— 它要读 S.trades / S.watchlist
     组织上下文。initQa 里绑事件只做一次（重复登录不能重复绑），
     qaBoot 拉云端历史，失败不影响应用其它部分。
     注意顺序：initQa → qaSyncSendState 会读 ModelMgr.cur 写底部提示文案，
     所以它必须排在 ModelMgr.loadCur() 之后。旧版把问答放在模型之前，
     导致首次进入即使配好模型，底部也一直显示「尚未选择模型…」（且没有
     任何后续时机再刷新这行字）。 */
  if (typeof initQa === 'function') {
    if (!initQa._bound) { try { initQa(); initQa._bound = true; } catch (e) { /* */ } }
    else { renderQaMessages(); renderQaHistory(); qaSyncSendState(); }
    if (typeof qaBoot === 'function') qaBoot().catch(() => { /* */ });
  }
  /* v3.10.1 K线库每日自动入库：进入应用后后台静默增量（开关在 设置→数据管理→K线库，
     仅当库已建立且缺最新交易日才拉，30 分钟节流；首次回补不自动跑）。失败不影响进入应用。 */
  try {
    if (typeof KLib !== 'undefined') KLib.autoSyncIfStale().then(r => {
      if (r && !r.skipped && r.fetched) toast('K线库已自动同步：' + r.n + ' 只 · 最新 ' + r.targetDate);
    }).catch(() => { /* */ });
  } catch (e) { /* */ }
  /* v3.18.0 静态数据中心：启动兜底回读（IndexedDB）+ 每日定时更新入口。
     hydrate 在 StockDict.init 的种子加载之后再应用（apply 合并式，不会删掉种子条目）。 */
  try {
    if (typeof DataHub !== 'undefined') {
      DataHub.startTimer();
      setTimeout(() => { DataHub.hydrate().catch(() => { /* */ }); }, 3000);
    }
  } catch (e) { /* */ }
  if (ensureCloudLlm()) {
    /* 目录是异步拉的，拉到后 cur 可能从 null 变成实模型（savedId 二次解析），
       所以 reload 完成后必须再同步一次问答区文案，否则提示会停在旧状态。 */
    ModelMgr.reload().then(() => {
      try { if (typeof qaSyncSendState === 'function') qaSyncSendState(); } catch (e) { /* */ }
    }).catch(e => {
      const st = $('modelStatus');
      if (st) st.textContent = '模型列表加载失败：' + (e.message || e);
    });
  }
  StockDict.init();
  renderAll();
  refreshQuotes().catch(() => { /* 行情失败页面显示未获取 */ });   // 网络行情到齐后再刷一遍
}
export function switchAuthForm(id) {
  for (const f of ['loginForm', 'initForm', 'forcePwdForm']) $(f).hidden = f !== id;
  $('tabLogin').classList.toggle('active', id === 'loginForm');
  $('tabInit').classList.toggle('active', id === 'initForm');
}
export function authMsg(text, ok) {
  const el = $('authMsg');
  el.hidden = false;
  el.textContent = text;
  el.className = 'auth-msg ' + (ok ? 'ok' : 'err');
}

/* ============================================================
   数据加载
   ============================================================ */
/* ============================================================
   渲染
   ============================================================ */
