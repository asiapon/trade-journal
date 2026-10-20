/* 视图绑定：全站事件委托 bindEvents / 视图切换 switchView / 行情悬浮球（v0.11.0 自单体拆出） */
import { $, toast, fmt2, fmtP, fmtPct, pnlCls, esc, fmtTime, nowLocalInput, inferMarket, MKT_NAME } from '../shared/utils.js';
import { NetLog, sjTokenHeaders } from '../core/netlog.js';
import { StockDict } from '../core/stockdict.js';
import { DL } from '../core/data-layer.js';
import { emQuote, txQuote } from '../sources/quotes.js';
import { ACCESS_KEY, BACKEND_URL, CLOUD_HOST, RPC_BASE, TABLES, cloudStore, loadAll, localStore, rpc, saveSetting, sessionHooks, setStore, storageHooks, store, setupAdmin, changePassword } from '../storage/gateway.js';
import { S } from '../core/app-state.js';
import { U } from '../core/ui-state.js';
import { renderAll } from '../app.js';
import { doLogin, doLogout, switchAuthForm, authMsg, Auth } from '../features/auth.js';
import { renderAnalysisSelect } from '../features/diagnose.js';
import { aiParseEntry, autoWatchOnBuy, buildTradeRow, calcFees, closeRecModal, feeDetailRow, fillFormFromParsed, fillTradeForm, isInitTrade, openRecModal, pendingTrades, quoteMap, reconcileParsedCode, renderTrades, resetTradeForm, resolveTfStock, setManualOpen, setTfStock, syncTfTypeTabs, updateFeePreview } from '../features/journal.js';
import { loadUsers, renderFeeEditor, renderMe, renderNetLogUI, saveFeeEditor, switchSetPane } from '../features/me.js';
import { HOLD_MOUNTS, WATCH_MOUNTS, feeOpenIds, renderHoldings, renderToday, stockDetailRow, stockOpenCodes } from '../features/overview.js';
import { qaSyncSendState, renderQaHistory, renderQaMessages } from '../features/qa.js';
import { ModelMgr, refreshQuotes } from '../features/quotes.js';
import { sjAsrCfgGet, sjAsrCfgSet } from '../features/voice.js';
import { bindWatchCard, closeWatchModal } from '../features/watchlist.js';
import { bindSuggest, closeConfirm, confirmCb, confirmDlg, confirmInputCb, promptDlg } from './widgets.js';

export function bindEvents() {
  /* 认证 */
  $('tabLogin').addEventListener('click', () => switchAuthForm('loginForm'));
  $('tabInit').addEventListener('click', () => switchAuthForm('initForm'));
  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await doLogin($('loginUser').value.trim(), $('loginPass').value);
    } catch (err) { authMsg(err.message || '登录失败'); }
  });
  $('initForm').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const u = $('initUser').value.trim(), p = $('initPass').value;
      await Auth.setupAdmin(u, p);
      authMsg('管理员创建成功，自动登录中…', true);
      await doLogin(u, p);
    } catch (err) { authMsg(err.message || '初始化失败'); }
  });
  $('forcePwdForm').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await Auth.changePassword(S.user.username, $('forceOld').value, $('forceNew').value);
      S.user.must_change_pwd = false;
      localStorage.setItem('sj_user', JSON.stringify(S.user));
      await enterApp();
      toast('密码已修改');
    } catch (err) { authMsg(err.message || '修改失败'); }
  });
  document.querySelectorAll('.pwd-eye').forEach(b => b.addEventListener('click', () => {
    const inp = $(b.dataset.eye);
    inp.type = inp.type === 'password' ? 'text' : 'password';
  }));
  /* v3.8.57 登录页键盘防遮挡改为纯 CSS 静态上偏（见 style.css .auth-card），
     不再绑定 focus/blur 事件做动态位移——避免输入框之间切换时卡片跳动。 */

  /* 导航 */
  document.querySelectorAll('[data-view]').forEach(btn => btn.addEventListener('click', () => switchView(btn.dataset.view)));
  document.querySelectorAll('[data-goto]').forEach(btn => btn.addEventListener('click', () => switchView(btn.dataset.goto)));
  $('logoutBtn').addEventListener('click', () => doLogout(false));

  /* 模态：确认框与输入框共用同一个「确定」按钮（v3.8.43） */
  $('confirmCancel').addEventListener('click', closeConfirm);
  /* v3.8.50 点遮罩空白处即关闭（点弹窗内部不关），新建/删除分组等无需非点「取消」不可 */
  $('confirmModal').addEventListener('click', e => { if (e.target === $('confirmModal')) closeConfirm(); });
  $('confirmOk').addEventListener('click', () => {
    const cb = confirmInputCb || confirmCb;
    const val = confirmInputCb ? $('confirmInput').value.trim() : null;
    closeConfirm();
    if (cb) cb(val);
  });
  /* 输入框内：回车=确定，Esc=取消 */
  $('confirmInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); $('confirmOk').click(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeConfirm(); }
  });

  /* 交易页：AI 解析入口 + 待确认列表（v3.8.46 总览页的 quickNl 入口已随卡片下线） */
  $('tradeParseBtn').addEventListener('click', () => aiParseEntry('tradeNl', 'tradeHint'));
  ['tradeHint'].forEach(hid => $(hid).addEventListener('click', e => {
    const openM = e.target.closest('.p-open-manual');
    if (openM) { setManualOpen(true); return; }
    const saveAllB = e.target.closest('.p-saveall-btn');
    if (saveAllB) { saveAllPending(saveAllB, saveAllB.dataset.close === '1'); return; }
    const saveB = e.target.closest('.p-save-btn');
    if (saveB) {
      const t = pendingTrades[Number(saveB.dataset.i)];
      if (t) savePendingTrade(t, saveB, saveB.dataset.close === '1');
      return;
    }
    const b = e.target.closest('.pfill-btn');
    if (!b) return;
    const t = pendingTrades[Number(b.dataset.i)];
    if (!t) return;
    fillFormFromParsed(t);
    switchView('trades');
    openRecModal(false);
    $(b.dataset.hint).hidden = true;
    $(b.dataset.input).value = '';
  }));
  /* 解析结果一键入库（免表单） */
  async function savePendingTrade(t, btn, closeAfter = false) {
    if (t._saved) { toast('该笔已保存过'); return; }
    /* v3.8.60 入库前再校正一次代码（解析时字典可能尚未就绪，此处兜底） */
    t = reconcileParsedCode(t) || t;
    let code = t.code || '', name = t.name || '';
    if (!code && name) { const hit = StockDict.resolve(name); if (hit && hit.code) { code = hit.code; name = hit.name || name; } }
    if (!code) { toast('未能识别股票代码，请点「改」手动确认', 'warn'); return; }
    if (!(t.price > 0) || !(t.qty > 0)) { toast('价格或数量无法识别，请点「改」手动确认', 'warn'); return; }
    const row = buildTradeRow({
      type: t.type, code, name, market: t.market || inferMarket(code),
      price: parseFloat(t.price), qty: parseInt(t.qty, 10),
      time: (t.time && !isNaN(new Date(t.time))) ? t.time : nowLocalInput(), note: ''
    });
    btn.disabled = true;
    try {
      await store.insert('trades', row);
      await store.log('trade', `新增交易 ${row.stock_name || row.stock_code} ${row.transaction_type === 'buy' ? '买入' : '卖出'} ${row.quantity}股@${row.price}`);
      toast(`已保存：${row.stock_name || row.stock_code} ${row.transaction_type === 'buy' ? '买入' : '卖出'} ${row.quantity}股`);
      if (row.transaction_type === 'buy') await autoWatchOnBuy(code, row.stock_name);   // 买入自动加自选
      btn.textContent = '已存';
      t._saved = true;
      await loadAll(); renderAll(); refreshQuotes();
      if (closeAfter && $('recModal') && !$('recModal').hidden) closeRecModal();
    } catch (err) { btn.disabled = false; toast(err.message || '保存失败', 'warn'); }
  }
  /* 多条解析结果一键全部入库 */
  async function saveAllPending(btn, closeAfter = false) {
    const targets = pendingTrades.filter(t => !t._saved);
    if (!targets.length) { toast('没有待保存的记录'); return; }
    btn.disabled = true;
    let ok = 0;
    for (const t of targets) {
      const ghost = { disabled: false, textContent: '' };
      try { await savePendingTrade(t, ghost); if (t._saved) ok++; } catch (e) { /* 单笔失败继续 */ }
    }
    btn.disabled = false;
    if (ok === targets.length) {
      if (closeAfter) {
        if ($('recModal') && !$('recModal').hidden) closeRecModal(); else $('tradeHint').hidden = true;
        toast(`已全部保存（${ok} 笔）`);
      } else {
        /* 不关闭：刷新列表按钮状态，可继续解析录入 */
        const hid = btn.closest('.quick-hint');
        if (hid) hid.querySelectorAll('.p-save-btn').forEach(b => {
          const t = pendingTrades[Number(b.dataset.i)];
          if (t && t._saved) { b.textContent = '已存'; b.disabled = true; }
        });
        btn.textContent = '已全部保存';
        toast(`已全部保存（${ok} 笔）`);
      }
    } else {
      btn.textContent = `已保存 ${ok}/${targets.length}，其余请点「改」确认`;
    }
  }
  /* 记一笔弹窗：开关与关闭 */
  $('recModalBtn').addEventListener('click', () => { resetTradeForm(); openRecModal(); });
  $('recModalClose').addEventListener('click', closeRecModal);
  $('recModal').addEventListener('mousedown', e => { if (e.target === $('recModal')) closeRecModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('recModal').hidden) closeRecModal(); });
  /* v3.8.78 加自选弹窗：关闭按钮 / 点遮罩关闭 / Esc 关闭（与「记一笔」完全一致的关闭手势） */
  if ($('watchModal')) {
    $('watchModalClose').addEventListener('click', closeWatchModal);
    $('watchModal').addEventListener('mousedown', e => { if (e.target === $('watchModal')) closeWatchModal(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('watchModal').hidden) closeWatchModal(); });
  }

  /* AI 模型 */
  $('modelCurSel').addEventListener('change', () => { ModelMgr.setCur($('modelCurSel').value); toast('已切换模型'); });
  $('modelReloadBtn').addEventListener('click', async () => {
    const st = $('modelStatus');
    st.textContent = '模型列表刷新中…';
    try { await ModelMgr.reload(); toast('模型列表已刷新'); }
    catch (e) { st.textContent = '模型列表加载失败：' + (e.message || e); }
  });
  $('customModelForm').addEventListener('submit', e => {
    e.preventDefault();
    const m = {
      key: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: $('cmName').value.trim(),
      baseUrl: $('cmBaseUrl').value.trim(),
      model: $('cmModel').value.trim(),
      apiKey: $('cmApiKey').value.trim()
    };
    ModelMgr.custom.push(m);
    ModelMgr.saveCustom();
    /* v3.15.2 添加后自动启用。注意必须用 'c:' + key 字符串 —— 此前传原始对象给
       modelId()，对象上没有 custom 标记，生成的是 'p:undefined'，setCur 永远找不到，
       「配了 DeepSeek 却还在用旧模型/显示未配置」的真凶就是它 */
    ModelMgr.setCur('c:' + m.key);
    $('cmName').value = $('cmBaseUrl').value = $('cmModel').value = $('cmApiKey').value = '';
    toast('自定义模型已添加并启用：' + m.name);
  });
  $('customModelList').addEventListener('click', e => {
    const b = e.target.closest('.cm-del');
    if (!b) return;
    ModelMgr.custom = ModelMgr.custom.filter(c => c.key !== b.dataset.key);
    ModelMgr.saveCustom();
    ModelMgr.loadCur(); ModelMgr.render();
  });

  /* v3.9.9 技能中心：妙想 Key 配置 + 技能添加/删除/启停（事件委托，列表随渲染重建） */
  $('mxKeyEye').addEventListener('click', () => {
    const inp = $('mxKeyInput');
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });
  $('mxKeySaveBtn').addEventListener('click', () => {
    const v = $('mxKeyInput').value.trim();
    if (!v) { toast('请先粘贴 mkt_ 开头的妙想 Key', 'warn'); return; }
    mxKeySet(v);
    $('mxKeyInput').value = '';
    const st = $('mxKeyStatus'); if (st) st.dataset.dirty = '1';
    mxKeyStatusRender('已保存：<span class="mx-ok">' + esc(mxKeyMask()) + '</span>（仅本机浏览器）· 妙想类技能立即可用，可点「测试连接」验证。');
    renderSkillCenter(); qaRefreshSkillHint();
    toast('妙想 Key 已保存（仅本机）');
  });
  $('mxKeyClearBtn').addEventListener('click', () => {
    if (!mxKeyGet()) { toast('当前没有保存过 Key'); return; }
    if (!confirm('确认清除本机保存的妙想 Key？清除后妙想类技能退回「待配置凭据」，问答改用免费公开数据源。')) return;
    mxKeySet('');
    const st = $('mxKeyStatus'); if (st) st.dataset.dirty = '1';
    mxKeyStatusRender();
    renderSkillCenter(); qaRefreshSkillHint();
    toast('妙想 Key 已清除');
  });
  $('mxKeyTestBtn').addEventListener('click', async () => {
    const v = $('mxKeyInput').value.trim() || mxKeyGet();
    const st = $('mxKeyStatus');
    if (!v) { mxKeyStatusRender('<span class="mx-err">请先粘贴 Key（或先保存过一把）再测试</span>'); return; }
    mxKeyStatusRender('测试连接中…（妙想免费额度约 2 秒才能问一次，请稍候）');
    try {
      const r = await mxQuery('贵州茅台最新收盘价', { key: v, timeout: 30000 });
      mxKeyStatusRender('<span class="mx-ok">✅ 连接成功</span>（耗时 ' + (r.ms || 0) + 'ms，返回 '
        + (r.tables && r.tables.length ? r.tables.length + ' 张数据表' : '文本结果') + '）。记得点「保存」把 Key 存进本机。');
      if (st) delete st.dataset.dirty;
    } catch (e) {
      mxKeyStatusRender('<span class="mx-err">❌ 连接失败：' + esc(e.message || e) + '</span>');
    }
  });
  /* v3.17.0 语音转写配置（本机 sj_asr_v1）：后端选择 + 硅基/腾讯密钥，全部不上云 */
  const asrStatusRender = t => { const st = $('asrStatus'); if (st) st.innerHTML = t; };
  (function asrInitUI() {
    const c = sjAsrCfgGet();
    $('asrBackend').value = c.backend;
    if (c.sfKey) $('asrSfKey').placeholder = '硅基流动 Key（已存本机 ' + c.sfKey.slice(0, 5) + '…' + c.sfKey.slice(-4) + '，可粘贴覆盖）';
    if (c.txId) $('asrTxId').placeholder = 'SecretId（已存本机 ' + c.txId.slice(0, 6) + '…，可粘贴覆盖）';
    if (c.txKey) $('asrTxKey').placeholder = 'SecretKey（已存本机 ****' + c.txKey.slice(-4) + '，可粘贴覆盖）';
  })();
  $('asrSfEye').addEventListener('click', () => {
    const i = $('asrSfKey'); i.type = i.type === 'password' ? 'text' : 'password';
  });
  $('asrSaveBtn').addEventListener('click', () => {
    const sf = $('asrSfKey').value.trim(), tid = $('asrTxId').value.trim(), tkey = $('asrTxKey').value.trim();
    const prev = sjAsrCfgGet();
    const c = sjAsrCfgSet({
      backend: $('asrBackend').value,
      sfKey: sf || prev.sfKey,
      txId: tid || prev.txId,
      txKey: tkey || prev.txKey,
    });
    $('asrSfKey').value = ''; $('asrTxId').value = ''; $('asrTxKey').value = '';
    asrStatusRender('<span class="mx-ok">✅ 已保存（仅本机）</span>：后端=' + esc(c.backend)
      + (c.sfKey ? ' · 硅基 Key 已存' : '') + (c.txId ? ' · 腾讯云密钥已存' : ''));
    toast('语音转写配置已保存（仅本机）');
  });
  $('asrClearBtn').addEventListener('click', () => {
    if (!confirm('确认清除本机保存的全部语音转写配置（后端选择 / 各 Key）？')) return;
    localStorage.removeItem('sj_asr_v1');
    $('asrBackend').value = 'auto';
    asrStatusRender('已清除');
    toast('语音转写配置已清除');
  });
  $('asrTestBtn').addEventListener('click', async () => {
    const c = sjAsrCfgGet();
    const lines = [];
    if (c.backend === 'tx' || c.backend === 'auto') {
      try {
        const r = await fetch('/api/asr/tencent', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, (typeof sjTokenHeaders === 'function' ? sjTokenHeaders() : {})),
          body: '{}',
        });
        const j = await r.json().catch(() => ({}));
        lines.push(r.status === 400 ? '✅ 腾讯云代理可达（服务器密钥已配置）'
          : r.status === 501 ? '⚠️ 腾讯云代理可达但未配密钥（服务器 .env 或上方表单填一对后保存）'
          : r.status === 404 ? '❌ 当前页面没有自托管后端（/api/asr/tencent 不存在）——云端版用不了腾讯云，请配硅基流动'
          : '❌ 腾讯云代理异常 HTTP ' + r.status + (j.msg ? '：' + esc(j.msg) : ''));
      } catch (e) { lines.push('❌ 腾讯云代理连不上（当前是云端版？腾讯云仅自托管可用）'); }
    }
    lines.push(c.sfKey ? '✅ 硅基流动 Key 已存本机' : '⚠️ 硅基流动 Key 未配置（云端版直连必需）');
    asrStatusRender(lines.join('<br>'));
  });

  const onSkillListClick = e => {
    const b = e.target.closest('[data-sk]');
    if (!b) return;
    const id = b.dataset.sid, act = b.dataset.sk;
    if (act === 'toggle') {
      const s = skillById(id);
      skillSetEnabled(id, !skillEnabled(id));
      toast(s && skillEnabled(id) ? '已启用「' + s.name + '」' : '已停用「' + (s && s.name || id) + '」');
    } else if (act === 'del') {
      const s = skillById(id);
      const isUser = String(id).indexOf('user-') === 0;
      if (!confirm(isUser
        ? '删除自定义技能「' + (s && s.name || id) + '」？删除后需重新创建（不可恢复）。'
        : '卸载「' + (s && s.name || id) + '」？卸载后问答不再调用它，可在「可添加的技能」里随时装回来。')) return;
      skillUninstall(id);
    } else if (act === 'add') {
      const s = skillById(id);
      skillInstall(id);
      toast('已添加「' + (s && s.name || id) + '」');
    } else if (act === 'upd') {
      /* v3.12.2 技能包更新：幂等重装（重新下载 SKILL.md 覆盖），报告函数增删 */
      const s = skillById(id);
      if (!s || !s.isPack) return;
      toast('正在更新「' + s.name + '」…');
      skillPackInstall(s.url, s.packName).then(r => {
        const diffTxt = (r.added && r.added.length ? '，新增 ' + r.added.length : '') + (r.removed && r.removed.length ? '，移除 ' + r.removed.length : '');
        toast('✅ 已更新「' + s.name + '」（' + r.functions + ' 个函数' + diffTxt + '）');
        renderSkillCenter(); qaRefreshSkillHint();
      }).catch(e => { toast('更新失败：' + (e.message || e), 'warn'); renderSkillCenter(); });
      return;
    }
    renderSkillCenter(); qaRefreshSkillHint();
  };
  $('skillListOn').addEventListener('click', onSkillListClick);
  $('skillListOff').addEventListener('click', onSkillListClick);

  /* v3.11.0 自定义技能：表单保存（名称/触发词/报表/排序/列映射 → 本机注册 → 立即可对话调用） */
  $('uskSaveBtn').addEventListener('click', () => {
    const name = $('uskName').value.trim();
    const kws = $('uskKeywords').value.split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean);
    const report = $('uskReport').value.trim().toUpperCase();
    const msg = $('uskMsg');
    if (!name || !kws.length || !report) { msg.textContent = '✗ 名称 / 触发关键词 / 报表名 都是必填'; return; }
    if (!/^RPT[A-Z0-9_]*$/.test(report)) { msg.textContent = '✗ 报表名应以 RPT 开头（东财数据中心命名），如 RPT_LIFT_STAGE'; return; }
    const cols = $('uskCols').value.split(/[,，]+/).map(s => s.trim()).filter(Boolean)
      .map(pair => { const m = pair.split('=').map(x => x.trim()); return { f: m[0], t: m[1] || m[0] }; });
    userSkillSaveRec({
      id: 'user-' + Date.now(),
      name: name,
      icon: '🧩',
      keywords: kws,
      report: report,
      sortCol: $('uskSortCol').value.trim().toUpperCase(),
      sortTypes: $('uskSortDir').value === '1' ? 1 : -1,
      size: Math.min(200, Math.max(1, parseInt($('uskSize').value, 10) || 30)),
      stock: $('uskStock').checked,
      cols: cols,
      enabled: true,
    });
    $('uskName').value = ''; $('uskKeywords').value = ''; $('uskReport').value = ''; $('uskCols').value = '';
    msg.textContent = '✅ 已保存并启用，去问答里用触发词试试（如「' + kws[0] + '」）';
    renderSkillCenter(); qaRefreshSkillHint();
    toast('自定义技能「' + name + '」已创建');
  });

  /* v3.12.0 SKILL.md 技能包：运行时地址 + 整包安装（a-stock-data 等）
     pkRuntime 读写 sj_backend_url —— 它同时是数据 RPC 的后端地址（混合模式总开关） */
  $('pkRuntime').value = BACKEND_URL;
  $('pkSaveRuntimeBtn').addEventListener('click', () => {
    try { localStorage.setItem('sj_backend_url', $('pkRuntime').value.trim().replace(/\/+$/, '')); } catch (e) { /* */ }
    $('pkMsg').textContent = '✅ 后端服务器地址已保存，刷新页面后生效（数据与技能包都会指向它；清空并刷新 = 回到 WorkBuddy 云端）';
    toast('后端服务器地址已更新');
  });
  $('pkInstallBtn').addEventListener('click', async () => {
    if (typeof skillPackInstall !== 'function') return;
    const btn = $('pkInstallBtn'), msg = $('pkMsg');
    btn.disabled = true; msg.textContent = '⏳ 正在下载 SKILL.md 并合成 Python 模块…';
    try {
      const r = await skillPackInstall($('pkUrl').value.trim(), /a-stock-data/i.test($('pkUrl').value) ? 'askill' : undefined);
      msg.textContent = '✅ 已安装「' + r.name + '」（' + r.functions + ' 个函数），表格里可启停，问答里模型会自动调用';
      toast('技能包「' + r.name + '」已安装');
      renderSkillCenter(); qaRefreshSkillHint();
    } catch (e) {
      msg.textContent = '✗ ' + (e.message || e);
      toast('技能包安装失败', 'warn');
    }
    btn.disabled = false;
  });

  /* 设置：分类页签切换 */
  $('setTabs').addEventListener('click', e => {
    const b = e.target.closest('.set-tab');
    if (!b || b.hidden) return;
    switchSetPane(b.dataset.set);
  });

  /* NL 示例词条：点击填入输入框 */
  $('tradeChips').addEventListener('click', e => {
    const c = e.target.closest('.chip');
    if (c) { $('tradeNl').value = c.dataset.nl; $('tradeNl').focus(); }
  });

  /* 方向：买/卖 Tab 按钮（驱动隐藏 select） */
  $('tfTypeTabs').addEventListener('click', e => {
    const b = e.target.closest('.wtab'); if (!b) return;
    $('tfType').value = b.dataset.t;
    syncTfTypeTabs();
    updateFeePreview();
  });
  /* 手动录入区默认收起，点开关展开 */
  $('tfManualToggle').addEventListener('click', () => setManualOpen($('tfManualWrap').hidden));
  /* 交易表单：股票联想（选定后代码/名称/市场自动确定） */
  bindSuggest('tfStock', 'tfStockSug', h => {
    setTfStock(h.code, h.name);
    updateFeePreview();       // 内部已滚动到底
    $('tfPrice').focus();     // 选完股票，光标进价格框
  });
  $('tfStock').addEventListener('input', () => {
    const inp = $('tfStock');
    if (!(inp.dataset.code && inp.value.trim().startsWith(inp.dataset.code))) {
      delete inp.dataset.code; delete inp.dataset.sname;
    }
    updateFeePreview();
  });
  $('tfType').addEventListener('change', updateFeePreview);
  $('tfPrice').addEventListener('input', updateFeePreview);
  $('tfQty').addEventListener('input', updateFeePreview);
  $('tfReset').addEventListener('click', resetTradeForm);
  $('tradeForm').addEventListener('submit', async e => {
    e.preventDefault();
    const st = resolveTfStock();
    if (!st.code) { toast('请先从联想中选定股票', 'warn'); return; }
    /* 「保存并关闭」或编辑列表记录 → 保存后关弹窗；「保存」则留在弹窗继续录入 */
    const closeAfter = (e.submitter && e.submitter.id === 'tfSubmitClose') || !!S.editingTradeId;
    const row = buildTradeRow({
      type: $('tfType').value,
      code: st.code,
      name: st.name,
      market: st.market,
      price: parseFloat($('tfPrice').value),
      qty: parseInt($('tfQty').value, 10),
      time: $('tfTime').value,
      note: $('tfNote').value.trim()
    });
    try {
      if (S.editingTradeId) {
        await store.update('trades', S.editingTradeId, row);
        await store.log('update', `修改交易 ${row.stock_name || row.stock_code} ${row.transaction_type === 'buy' ? '买入' : '卖出'} ${row.quantity}股@${row.price}`);
        toast('已保存修改');
      } else {
        await store.insert('trades', row);
        await store.log('trade', `新增交易 ${row.stock_name || row.stock_code} ${row.transaction_type === 'buy' ? '买入' : '卖出'} ${row.quantity}股@${row.price}`);
        toast('已记录一笔操作');
        if (row.transaction_type === 'buy') await autoWatchOnBuy(row.stock_code, row.stock_name);   // 买入自动加自选
      }
      resetTradeForm();
      await loadAll(); renderAll();
      if (closeAfter) closeRecModal();
    } catch (err) { toast(err.message || '保存失败', 'warn'); }
  });

  /* 交易列表：筛选 / 编辑 / 删除 / 费用展开 */
  $('tradeModeTabs').addEventListener('click', e => {
    const b = e.target.closest('.wtab'); if (!b) return;
    U.tradeMode = b.dataset.m || 'list';
    try { localStorage.setItem('sj_tradeMode', U.tradeMode); } catch (err) { /* */ }
    document.querySelectorAll('#tradeModeTabs .wtab').forEach(x => x.classList.toggle('on', x === b));
    renderTrades();
  });
  document.querySelectorAll('#tradeModeTabs .wtab').forEach(x => x.classList.toggle('on', (x.dataset.m || 'list') === U.tradeMode));
  /* 默认时间范围：今天（与 chips 初始高亮一致） */
  (() => {
    const now = new Date();
    const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    $('ftFrom').value = iso(now); $('ftTo').value = iso(now);
  })();
  ['ftFrom', 'ftTo'].forEach(id => $(id).addEventListener('change', () => {
    /* 手动改日期时高亮回落到「全部」；日期清空则回到全部 */
    document.querySelectorAll('#ftChips .fchip').forEach(x => x.classList.toggle('on', x.dataset.q === 'all' && !$('ftFrom').value && !$('ftTo').value));
    renderTrades();
  }));
  /* 快捷时间 chips：近7天 / 近30天 / 近3月 / 今年以来 / 全部 */
  $('ftChips').addEventListener('click', e => {
    const b = e.target.closest('.fchip'); if (!b) return;
    document.querySelectorAll('#ftChips .fchip').forEach(x => x.classList.toggle('on', x === b));
    const now = new Date();
    const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const q = b.dataset.q;
    if (q === 'all') { $('ftFrom').value = ''; $('ftTo').value = ''; }
    else {
      $('ftTo').value = iso(now);
      if (q === 'today') { $('ftFrom').value = $('ftTo').value; }
      else if (q === '7d') { const d = new Date(now); d.setDate(d.getDate() - 6); $('ftFrom').value = iso(d); }
      else if (q === '30d') { const d = new Date(now); d.setDate(d.getDate() - 29); $('ftFrom').value = iso(d); }
      else if (q === '3m') { const d = new Date(now); d.setMonth(d.getMonth() - 3); $('ftFrom').value = iso(d); }
      else if (q === 'year') $('ftFrom').value = `${now.getFullYear()}-01-01`;
    }
    renderTrades();
  });
  $('ftKw').addEventListener('input', renderTrades);
  $('ftClear').addEventListener('click', () => {
    $('ftFrom').value = ''; $('ftTo').value = ''; $('ftKw').value = '';
    document.querySelectorAll('#ftChips .fchip').forEach(x => x.classList.toggle('on', x.dataset.q === 'all'));
    renderTrades();
  });
  $('tradeTable').querySelector('tbody').addEventListener('click', async e => {
    const editBtn = e.target.closest('.edit-trade');
    const delBtn = e.target.closest('.del-trade');
    const feeCell = e.target.closest('.fee-cell');
    const aggRow = e.target.closest('tr.stockagg');
    if (!editBtn && !delBtn && !feeCell && aggRow) {
      const code = aggRow.dataset.code;
      const next = aggRow.nextElementSibling;
      if (next && next.classList.contains('stock-detail-row')) { next.remove(); stockOpenCodes.delete(code); }
      else {
        const g = U.lastStockAgg.get(code);
        if (g) { aggRow.insertAdjacentHTML('afterend', stockDetailRow(g)); stockOpenCodes.add(code); }
      }
      return;
    }
    if (editBtn) {
      const t = S.trades.find(x => x.id == editBtn.dataset.id);
      if (t) fillTradeForm(t);
      return;
    }
    if (delBtn) {
      const t = S.trades.find(x => x.id == delBtn.dataset.id);
      confirmDlg('删除记录', `确认删除 ${t.stock_name || t.stock_code} ${t.transaction_type === 'buy' ? '买入' : '卖出'} ${t.quantity}股 @${fmtP(t.price)} 的记录？删除后持仓将重新计算。`, async () => {
        try {
          await store.remove('trades', t.id);
          feeOpenIds.delete(String(t.id));
          await store.log('delete', `删除交易 ${t.stock_name || t.stock_code} ${fmtP(t.price)}x${t.quantity}`);
          await loadAll(); renderAll();
          toast('已删除');
        } catch (err) { toast(err.message || '删除失败', 'warn'); }
      });
      return;
    }
    if (feeCell) {
      const tr = feeCell.closest('tr');
      const id = String(feeCell.dataset.id);
      const next = tr.nextElementSibling;
      if (next && next.classList.contains('fee-detail-row')) { next.remove(); feeOpenIds.delete(id); }
      else {
        const t = S.trades.find(x => x.id == feeCell.dataset.id);
        if (t) { tr.insertAdjacentHTML('afterend', feeDetailRow(t)); feeOpenIds.add(id); }
      }
    }
  });

  /* ---------- 持仓：刷新 / 自动刷新 / 表头排序 / 改价 ---------- */
  /* v3.8.37 持仓页下线：行情刷新入口只剩总览页一处 */
  const refreshQuotesAll = async () => { await loadAll(); await refreshQuotes(true); };
  /* v3.8.65 刷新入口变两处：大盘卡右上角（原位）+ 悬浮条（滚出视野后出现）。
     挂载点数组本就是为此设计的，追加 id 即可自动共用同一套逻辑与状态 */
  ['tvRefreshBtn', 'tvRefreshFab'].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.addEventListener('click', async (e) => {
      /* v3.9.6 点完主动失焦：按钮没有自定义 :focus 样式，用的是浏览器默认焦点环
         （按钮外圈那圈描边）。鼠标点过之后焦点一直留在按钮上，描边就那样挂着，
         直到用户点页面别处 —— 观感像「卡住了」。这里在点击处理的一开始就 blur，
         立刻消除描边（不等到刷新结束，网络慢时也不用盯着那圈框）。
         只对指针点击生效（e.detail > 0）：键盘 Enter/Space 触发的 click 其
         detail 为 0，此时保留焦点环才是正确的无障碍行为，也能连按 Enter 重复刷新。 */
      if (e && e.detail > 0 && document.activeElement === b) b.blur();
      await refreshQuotesAll();
      toast('已刷新行情');
    });
  });
  /* v3.8.65 悬浮条显隐：滚动/缩放时按需同步。
     用 rAF 节流 —— scroll 事件每秒可触发上百次，而 syncQuoteFab 里的
     getBoundingClientRect() 会强制同步布局，每次都跑代价太高 */
  if ($('quoteFab')) {
    let fabRaf = 0;
    const reqFabSync = () => {
      if (fabRaf) return;
      fabRaf = requestAnimationFrame(() => { fabRaf = 0; syncQuoteFab(); });
    };
    window.addEventListener('scroll', reqFabSync, { passive: true });
    window.addEventListener('resize', reqFabSync);
    /* v3.8.76 顺序调整：先定位、再决定显隐。
       旧顺序是 syncQuoteFab() 在前，会把 .on 加上触发淡入，而定位在下一行才做；
       同一次同步执行里浏览器一般来不及画中间帧，但先定位更稳妥（首帧就是正确位置）。 */
    initQuoteFabDrag();
    syncQuoteFab();
  }
  /* v3.8.69 跨 720px 断点时重渲染指数条：涨跌额只在窄屏显示，转屏 / 拉窗口后
     必须重新生成 HTML（否则从宽变窄不会冒出来）。只在「跨过断点」时触发一次，
     普通 resize（手机地址栏收起等）不重渲染，避免白白重建 DOM */
  let idxNarrowPrev = window.matchMedia('(max-width: 720px)').matches;
  window.addEventListener('resize', () => {
    const now = window.matchMedia('(max-width: 720px)').matches;
    if (now === idxNarrowPrev) return;
    idxNarrowPrev = now;
    if (typeof renderToday === 'function') renderToday();
  });
  $('holdRecBtn').addEventListener('click', () => openRecModal());
  /* 空态「去记一笔」：每个持仓挂载点各绑一份 */
  for (const m of HOLD_MOUNTS) {
    const rb = m.recBtn ? document.getElementById(m.recBtn) : null;
    if (rb) rb.addEventListener('click', () => openRecModal());
  }
  /* 自动刷新：总览页行情条的下拉
     v3.8.75 悬浮条已去掉「自动刷新」入口，挂载点只剩大盘卡里的 #tvAuto */
  let holdTimer = null;
  function setHoldAuto(sec, from) {
    if (holdTimer) { clearInterval(holdTimer); holdTimer = null; }
    sec = parseInt(sec, 10) || 0;
    ['tvAuto'].forEach(id => {
      const s = document.getElementById(id);
      if (s && s !== from) s.value = String(sec);
    });
    if (sec > 0) holdTimer = setInterval(() => { refreshQuotes(true).catch(() => { /* */ }); }, sec * 1000);
  }
  ['tvAuto'].forEach(id => {
    const s = document.getElementById(id);
    if (s) s.addEventListener('change', () => setHoldAuto(s.value, s));
  });
  setHoldAuto(($('tvAuto') || {}).value || '0');
  /* 点现价手填改价（总览页与持仓页挂载点共用） */
  function startPriceEdit(tr, code, name) {
    const cell = tr.querySelector('.price-cell');
    if (!cell || cell.querySelector('input')) return;
    const q = quoteMap().get(code);
    cell.innerHTML = `<input type="number" step="0.001" min="0" style="width:84px;padding:5px 8px;border:1px solid var(--blue);border-radius:6px" value="${q ? q.price ?? '' : ''}">`;
    const inp = cell.querySelector('input');
    inp.focus();
    const commit = async () => {
      const v = parseFloat(inp.value);
      if (!(v > 0)) { renderHoldings(); return; }
      try {
        const exist = S.quotes.find(x => x.stock_code === code);
        if (exist) await store.update('quotes', exist.id, { price: v, stock_name: name || exist.stock_name });
        else await store.insert('quotes', { stock_code: code, stock_name: name || '', price: v });
        await store.log('quote', `更新 ${name || code} 现价 ${v}`);
        await loadAll(); renderHoldings(); renderToday();
      } catch (err) { toast(err.message || '保存失败', 'warn'); renderHoldings(); }
    };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') renderHoldings(); });
    inp.addEventListener('blur', commit);
  }
  /* 持仓表：表头三态排序 + 点价改价（HOLD_MOUNTS 内每个挂载点都绑一份） */
  for (const m of HOLD_MOUNTS) {
    const tb = document.getElementById(m.pc);
    if (!tb) continue;
    const thead = tb.querySelector('thead');
    if (thead) thead.addEventListener('click', e => {
      const th = e.target.closest('th.sortable'); if (!th) return;
      const k = th.dataset.sort;
      if (U.holdSort.key !== k) U.holdSort = { key: k, dir: 1 };
      else if (U.holdSort.dir === 1) U.holdSort = { key: k, dir: -1 };
      else U.holdSort = { key: null, dir: 0 };
      renderHoldings();
    });
    const tbody = tb.querySelector('tbody');
    if (tbody) tbody.addEventListener('click', e => {
      const sp = e.target.closest('.set-price');
      if (sp) { startPriceEdit(sp.closest('tr'), sp.dataset.code, sp.dataset.name); return; }
    });
  }

  /* ---------- 自选：添加 / 编辑 / 分组 / 排序（WATCH_MOUNTS 内每个挂载点都绑一份） ---------- */
  for (const m of WATCH_MOUNTS) bindWatchCard(m);

  /* v3.8.23 网络日志：下载 / 清空 */
  $('netLogDlBtn').addEventListener('click', async () => {
    /* v3.18.1 云端/file：没有服务端 → 前端日志由浏览器 Blob 本地生成 .log 下载。
       自托管：仍走服务端 /api/logs/download（v3.15.1 fetch 带 token，location.href 无法带自定义头）。 */
    const isSelfHost = !(location.hostname.endsWith('workbuddy.host')) && location.protocol !== 'file:';
    if (!isSelfHost) {
      const txt = (typeof NetLog !== 'undefined') ? NetLog.text() : '';
      if (!txt) { toast('还没有前端调用日志', 'warn'); return; }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([txt], { type: 'text/plain;charset=utf-8' }));
      a.download = 'app-frontend-' + new Date().toISOString().slice(0, 10) + '.log';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
      return;
    }
    try {
      const r = await fetch('/api/logs/download', { headers: sjTokenHeaders() });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'app-' + new Date().toISOString().slice(0, 10) + '.log';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    } catch (e) { toast('下载失败：' + (e.message || e), 'warn'); }
  });
  $('netLogClearBtn').addEventListener('click', () => { renderNetLogUI(); });

  /* v3.18.2 K线库卡已并入静态数据中心卡（日K行「更新」= KLib.ensure，重复入口删除），
     原 renderKlibStatUI / klibAutoChk / klibSyncBtn 绑定随之移除；
     KLib 打开应用时自动增量同步（autoSyncIfStale）不依赖该开关，保持默认开启 */

  /* v3.18.0 静态数据中心：状态表 + 定时开关/时刻 + 全部/单数据集更新（设置 → 数据管理） */
  async function renderDataHubUI() {
    const sum = $('dhSummary'), tbl = $('dhTable');
    if (!sum) return;
    if (typeof DataHub === 'undefined') { sum.textContent = '静态数据中心模块未加载'; return; }
    /* 状态摘要：各数据集当前条数（内存态，即真实生效的数据） */
    let dictN = 0, dictV = '?';
    try {
      dictN = Object.keys(StockDict.d).length;
      const seed = JSON.parse(localStorage.getItem('sj_stock_dict_seed') || 'null');
      dictV = (seed && seed.v) || '随应用打包';
    } catch (e) { /* */ }
    let boardN = 0, boardV = '?';
    try {
      boardN = (state.boardDict || []).length;
      const bd = JSON.parse(localStorage.getItem('sj_board_dict_v1') || 'null');
      boardV = (bd && bd.v) || '随应用打包';
    } catch (e) { /* */ }
    let kTxt = '未建立';
    try {
      const meta = (typeof KLib !== 'undefined') ? await KLib.metaGet().catch(() => ({})) : {};
      if (meta.n) kTxt = meta.n + ' 只 · 到 ' + meta.targetDate;
    } catch (e) { /* */ }
    let wTxt = (DataHub._weekMap && DataHub._weekVer) ? ('已聚合 ' + DataHub._weekMap.size + ' 只 · 到 ' + DataHub._weekVer) : '按需聚合';
    sum.textContent = `股票名录 ${dictN} 条（${dictV}）｜板块成分 ${boardN} 个（${boardV}）｜日K ${kTxt}｜周K ${wTxt}`;
    const last = DataHub.lastGet();
    tbl.innerHTML = '<div class="table-wrap"><table class="batch-table"><thead><tr>'
      + '<th>数据集</th><th>内容</th><th>上次更新</th><th></th>'
      + '</tr></thead><tbody>'
      + DataHub.DS.map(x => {
        const l = last[x.key];
        const lt = !l ? '—' : (l.d + (l.ok ? '' : '（失败）'));
        return '<tr><td><b>' + esc(x.label) + '</b></td><td class="hint" style="margin:0">' + esc(x.desc)
          + '</td><td>' + esc(lt) + '</td>'
          + '<td><button class="btn ghost sm" data-dh-ds="' + x.key + '" type="button">更新</button></td></tr>';
      }).join('')
      + '</tbody></table></div>';
  }
  $('dhAutoChk').checked = (typeof DataHub !== 'undefined') ? DataHub.autoOn() : true;
  $('dhAutoAt').value = (typeof DataHub !== 'undefined') ? DataHub.autoAt() : '16:30';
  $('dhAutoChk').addEventListener('change', () => {
    if (typeof DataHub === 'undefined') return;
    try { localStorage.setItem(DataHub.AUTO_KEY, $('dhAutoChk').checked ? '1' : '0'); } catch (e) { /* */ }
    toast($('dhAutoChk').checked ? '已开启：到设定时刻自动更新' : '已关闭自动更新');
  });
  $('dhAutoAt').addEventListener('change', () => {
    if (typeof DataHub === 'undefined') return;
    const v = $('dhAutoAt').value;
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(v)) { toast('时刻格式不对', 'warn'); return; }
    try { localStorage.setItem(DataHub.AUTO_AT_KEY, v); } catch (e) { /* */ }
    toast('已保存：每天 ' + v + ' 后自动更新');
  });
  /* 全部更新 / 单数据集更新共用入口：busy 期间禁用按钮 + 进度落到按钮文字 */
  async function dhRun(keys, btn, busyText) {
    if (typeof DataHub === 'undefined') return;
    if (DataHub._busy) { toast('已有更新在进行中，请等它跑完', 'warn'); return; }
    const old = btn.textContent;
    btn.disabled = true;
    try {
      const r = await DataHub.updateAll(p => {
        const lb = p.total ? `（${p.done}/${p.total}）` : '';
        btn.textContent = '⏳ ' + (busyText || '更新中') + lb.slice(0, 10);
      }, { only: keys });
      const parts = keys.map(k => {
        const x = r[k];
        if (!x) return '';
        if (!x.ok) return k + '失败：' + x.err;
        const rr = x.r || {};
        return k + ' 完成' + (rr.n != null ? '（' + rr.n + '）' : '') + (rr.ver ? ' 到 ' + rr.ver : '');
      }).filter(Boolean);
      toast(parts.join('；') || '完成');
    } catch (e) { toast('更新失败：' + (e && e.message || e)); }
    btn.disabled = false; btn.textContent = old;
    renderDataHubUI();
  }
  $('dhSyncBtn').addEventListener('click', e => {
    dhRun(DataHub.DS.map(x => x.key), e.currentTarget, '更新中');
  });
  $('dhTable').addEventListener('click', e => {
    const b = e.target.closest('button[data-dh-ds]');
    if (!b) return;
    dhRun([b.dataset.dhDs], b, '更新中');
  });
  setTimeout(renderDataHubUI, 80);


  /* 我的：费率 */
  $('feeSaveBtn').addEventListener('click', saveFeeEditor);
  $('feeResetBtn').addEventListener('click', () => { S.settings.fee = null; delete S.settings.fee; renderFeeEditor(); toast('已恢复默认（记得保存生效）'); });
  $('calcBtn').addEventListener('click', () => {
    const amount = parseFloat($('calcAmount').value);
    if (!(amount >= 0)) { $('calcResult').innerHTML = ''; return; }
    const mk = $('calcMarket').value;
    const dir = $('calcType').value;
    const detail = f => `
      <span>佣金 <b>${fmt2(f.commission)}</b></span>
      <span>印花税 <b>${fmt2(f.stamp)}</b></span>
      <span>过户费 <b>${fmt2(f.transfer || 0)}</b></span>
      <span>经手费 <b>${fmt2(f.handling || 0)}</b></span>
      <span>证管费 <b>${fmt2(f.gov || 0)}</b></span>`;
    if (dir === 'both') {
      const buy = calcFees(amount, 'buy', mk), sell = calcFees(amount, 'sell', mk);
      $('calcResult').innerHTML = `
        <span>买入合计 <b>${fmt2(buy.total)}</b></span>${detail(buy)}
        <span>卖出合计 <b>${fmt2(sell.total)}</b></span>${detail(sell)}`;
    } else {
      const f = calcFees(amount, dir, mk);
      $('calcResult').innerHTML = `
        <span>${dir === 'buy' ? '买入' : '卖出'}费用合计 <b>${fmt2(f.total)}</b></span>${detail(f)}`;
    }
  });

  /* 我的：数据管理 */
  $('exportBtn').addEventListener('click', () => {
    const data = {
      version: 2, exported_at: new Date().toISOString(), mode: S.mode,
      trades: S.trades, watchlist: S.watchlist, quotes: S.quotes, settings: S.settings
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `操作日志备份-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('已导出备份');
  });
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data.trades) && !Array.isArray(data.watchlist)) { toast('备份文件格式不对', 'warn'); return; }
        confirmDlg('导入备份', `将清空当前全部数据并导入备份（交易 ${data.trades.length} 条、自选 ${data.watchlist.length} 条），确认继续？`, async () => {
          try {
            await store.clearData(['trades', 'watchlist', 'quotes', 'op_logs']);
            const strip = arr => (arr || []).map(({ id, owner_id, created_at, ...rest }) => rest);
            await store.bulkInsert('trades', strip(data.trades));
            await store.bulkInsert('watchlist', strip(data.watchlist));
            await store.bulkInsert('quotes', strip(data.quotes));
            if (data.settings) await saveSetting('fee', data.settings.fee || {});
            await store.log('import', `导入备份：交易 ${data.trades.length} 条、自选 ${data.watchlist.length} 条`);
            await loadAll(); renderAll();
            toast('导入完成');
          } catch (err) { toast(err.message || '导入失败', 'warn'); }
        }, '导入');
      } catch (err) { toast('备份文件解析失败', 'warn'); }
    };
    reader.readAsText(file);
    e.target.value = '';
  });
  $('clearBtn').addEventListener('click', () => {
    $('clearArea').hidden = false;
    $('clearConfirmInput').focus();
  });
  $('clearConfirmInput').addEventListener('input', () => {
    $('clearConfirmBtn').disabled = $('clearConfirmInput').value.trim() !== '清空';
  });
  $('clearConfirmBtn').addEventListener('click', async () => {
    try {
      await store.clearData(['trades', 'watchlist', 'quotes', 'op_logs']);
      await store.log('clear', '清空全部数据（费率保留）');
      $('clearArea').hidden = true;
      $('clearConfirmInput').value = '';
      $('clearConfirmBtn').disabled = true;
      await loadAll(); renderAll();
      toast('已清空全部数据');
    } catch (err) { toast(err.message || '清空失败', 'warn'); }
  });
  $('feeRecalcBtn').addEventListener('click', () => {
    const initRows = S.trades.filter(isInitTrade);
    const normal = S.trades.filter(t => !isInitTrade(t));
    const tip = initRows.length
      ? `\n\n· ${initRows.length} 条初始持仓记录（费用 0、成本=建仓价）将跳过，成本保持不变`
      : '';
    confirmDlg('重算历史费用', `将按当前费率设置与券商式费用口径（各项先按分取整再汇总；最低佣金由佣金补足规费差额）重新计算 ${normal.length} 条交易的费用与发生金额，持仓成本/盈亏随之变化。${tip}\n\n确定执行？`, async () => {
      try {
        let n = 0;
        for (const t of normal) {
          const fee = calcFees(t.gross_amount, t.transaction_type, t.market, t.stock_code);
          const net = t.transaction_type === 'buy' ? t.gross_amount + fee.total : t.gross_amount - fee.total;
          if (JSON.stringify(t.fee) !== JSON.stringify(fee) || Number(t.net_amount) !== net) {
            await store.update('trades', t.id, { fee, net_amount: net });
            n++;
          }
        }
        await store.log('update', `按当前费率重算历史费用（${n} 条变更）`);
        await loadAll(); renderAll(); refreshQuotes();
        toast(initRows.length ? `已重算：${n} 条变更（跳过 ${initRows.length} 条初始持仓）` : `已重算：${n} 条费用有变更`);
      } catch (err) { toast(err.message || '重算失败', 'warn'); }
    }, '重算');
  });
  $('seedBtn').addEventListener('click', async () => {
    confirmDlg('载入演示数据', '将写入 2 只持仓、5 条交易记录、3 只自选股及其现价（不影响现有数据，可随时清空）。', async () => {
      try {
        const T = (time, type, code, name, market, qty, price) => buildTradeRow({ type, code, name, market, price, qty, time });
        const trades = [
          T('2026-09-10T10:00', 'buy', '000063', '中兴通讯', 'sz', 1000, 38.50),
          T('2026-09-18T14:30', 'sell', '000063', '中兴通讯', 'sz', 500, 41.20),
          T('2026-09-25T09:40', 'buy', '300750', '宁德时代', 'sz', 200, 255.00),
          T('2026-10-08T11:05', 'buy', '601318', '中国平安', 'sh', 300, 52.60),
          T('2026-10-09T13:50', 'sell', '300750', '宁德时代', 'sz', 100, 248.00)
        ];
        for (const t of trades) await store.insert('trades', t);
        for (const w of [
          { stock_code: '600519', stock_name: '贵州茅台', group_name: '消费', note: '高端白酒观察，等回调', cur_price: 1500, prev_close: 1490, starred: true },
          { stock_code: '002594', stock_name: '比亚迪', group_name: '科技', note: '智驾进展跟踪', cur_price: 248, prev_close: 252, starred: false },
          { stock_code: '688041', stock_name: '海光信息', group_name: '科技', note: '国产算力', cur_price: 98.5, prev_close: 96.2, starred: false }
        ]) await store.insert('watchlist', w);
        await store.log('seed', '载入演示数据（2 持仓 / 5 交易 / 3 自选）');
        await loadAll(); renderAll();
        toast('演示数据已载入');
      } catch (err) { toast(err.message || '载入失败', 'warn'); }
    }, '载入');
  });
  $('logReloadBtn').addEventListener('click', async () => { await loadAll(); renderMe(); });

  /* v3.8.49 普通用户自助改密（管理员改他人密码走下面「用户管理」的「重置密码」） */
  $('myPwdForm').addEventListener('submit', async e => {
    e.preventDefault();
    const oldP = $('mpOld').value, n1 = $('mpNew').value, n2 = $('mpNew2').value;
    if (n1 !== n2) { toast('两次输入的新密码不一致', 'warn'); return; }
    if (n1.length < 6) { toast('新密码至少 6 位', 'warn'); return; }
    if (n1 === oldP) { toast('新密码与当前密码相同，无需修改', 'warn'); return; }
    try {
      const r = await rpc('app_change_pwd', { p_token: S.token, p_old: oldP, p_new: n1 });
      if (!r.ok) { toast(r.msg || '修改失败', 'warn'); return; }
      ['mpOld', 'mpNew', 'mpNew2'].forEach(id => { $(id).value = ''; });
      if (S.user) { S.user.must_change_pwd = false; try { localStorage.setItem('sj_user', JSON.stringify(S.user)); } catch (err) { /* */ } }
      await store.log('user', '修改本账号登录密码');
      toast('密码已修改，下次登录请用新密码');
    } catch (err) { toast(err.message || '修改失败', 'warn'); }
  });

  /* 用户管理 */
  $('userCreateForm').addEventListener('submit', async e => {
    e.preventDefault();
    const uname = $('nuName').value.trim();
    try {
      const r = await rpc('app_create_user', { p_token: S.token, p_username: uname, p_password: $('nuPass').value, p_role: $('nuRole').value });
      if (!r.ok) { toast(r.msg || '创建失败', 'warn'); return; }
      $('nuName').value = ''; $('nuPass').value = '';
      await store.log('user', `创建账号 ${uname}`);
      await loadUsers();
      toast('账号已创建（首次登录需改密）');
    } catch (err) { toast(err.message || '创建失败', 'warn'); }
  });
  $('userTable').querySelector('tbody').addEventListener('click', async e => {
    const resetBtn = e.target.closest('.reset-user');
    const delBtn = e.target.closest('.del-user');
    if (resetBtn) {
      const u = resetBtn.dataset.u;
      /* v3.8.43 同样改用自定义输入弹窗（原为浏览器原生 prompt） */
      promptDlg('重置密码', `为「${u}」设置新密码，至少 6 位。`, async newP => {
        if (!newP) return;
        try {
          const r = await rpc('app_reset_pwd', { p_token: S.token, p_username: u, p_new: newP });
          if (!r.ok) { toast(r.msg || '重置失败', 'warn'); return; }
          toast('已重置，该用户下次登录需改密');
        } catch (err) { toast(err.message || '重置失败', 'warn'); }
      }, { okText: '重置', placeholder: '至少 6 位' });
      return;
    }
    if (delBtn) {
      const u = delBtn.dataset.u;
      confirmDlg('删除账号', `确认删除账号「${u}」？该用户的全部交易、自选、日志数据将一并删除，不可恢复。`, async () => {
        try {
          const r = await rpc('app_delete_user', { p_token: S.token, p_username: u });
          if (!r.ok) { toast(r.msg || '删除失败', 'warn'); return; }
          await loadUsers();
          toast('账号已删除');
        } catch (err) { toast(err.message || '删除失败', 'warn'); }
      }, '删除');
    }
  });
}
export function syncQuoteFab() {
  const fab = document.getElementById('quoteFab');
  if (!fab) return;
  const today = document.getElementById('view-today');
  const anchor = document.getElementById('tvRefreshBtn');
  const show = !!(today && today.classList.contains('active'))
    && (!anchor || anchor.getBoundingClientRect().bottom < 0);
  fab.classList.toggle('on', show);
}

/* ---------- v3.8.66 行情悬浮条：可上下拖动 + 高度记忆 ----------
   横向不动，永远贴着右边（避免条子被拖到屏幕中间挡内容）；只让纵向可调，
   纵向由内联 top 接管。用户拖过之后把 top 写进 localStorage，下次打开仍停在他放的高度。
   v3.8.76：没有存档时也由 JS 量算真实落位（不再依赖 CSS 常量），只是不写存档 ——
   这样首屏位置和拖动后的位置用的是同一套算法，不会再出现「先压顶栏、一会儿跳下去」。 */
export const QF_POS_KEY = 'sj_qf_pos';
/* 纵向夹取：条子始终完整可见，且两头不让它压住顶栏 / 底部 Tab 栏 */
export function setQuoteFabTop(fab, t) {
  const h = fab.offsetHeight || 44;
  /* 上界：视口底；手机端再避开底部 Tab（底部导航 z-index 50 > 条子 45，压进去就点不到了） */
  let hi = window.innerHeight - h - 8;
  const nav = document.querySelector('.bottom-nav');
  if (nav && getComputedStyle(nav).display !== 'none') {
    hi = Math.min(hi, nav.getBoundingClientRect().top - 8 - h);
  }
  hi = Math.max(8, hi);
  /* 下界：顶栏底部 + 8。顶栏是 sticky，贴着它下沿既是「最上面」的位置，
     也不会遮住顶栏里的退出等按钮。
     v3.8.76：sticky 顶栏滚出视口后 rect.bottom 会变成负数（顶栏已经缩上去），
     此时不能再拿它当基准，否则 lo 变负、条子被顶到视口外。故夹到 [8, hi] 区间。
     v3.8.87：导航栏 .tabs 也吸顶了（PC 端），只让开顶栏会让悬浮条压在导航上 ——
     基准取「顶栏底」与「导航底」的较大者，两层都吸顶时自然落在导航之下；
     手机端 .tabs 是 display:none（rect 全 0），取 topbar 即可，行为不变。 */
  const bar = document.querySelector('.topbar');
  const barBottom = bar ? bar.getBoundingClientRect().bottom : 8;
  const tabs = document.querySelector('.tabs');
  let base = barBottom;
  if (tabs && getComputedStyle(tabs).display !== 'none') {
    const tr = tabs.getBoundingClientRect();
    if (tr.height > 0) base = Math.max(base, tr.bottom);
  }
  let lo = (base > 0 ? base : 8) + 8;
  lo = Math.max(8, Math.min(lo, hi));
  const t2 = Math.min(Math.max(lo, t), hi);
  fab.style.top = t2 + 'px';
  return t2;
}
export function saveQuoteFabPos(fab) {
  try {
    localStorage.setItem(QF_POS_KEY, JSON.stringify({ t: parseFloat(fab.style.top) || 0 }));
  } catch (e) { /* 隐私模式等写不进去，忽略：位置只是偏好，丢了不影响功能 */ }
}
export function initQuoteFabDrag() {
  const fab = $('quoteFab');
  if (!fab) return;
  /* v3.8.76 首次落位修复：不管有没有拖动存档，都先用 JS 量算一次真实位置。
     旧写法只在「有存档」时才 setQuoteFabTop()，没存档就纯靠 CSS 常量猜顶栏高度；
     而 topbar 是 sticky + height:auto，字体/图标晚加载会让它比常量更高，
     于是首屏悬浮条会先压住顶栏的退出按钮，等某次 scroll/resize 才纠正 —— 这就是
     「先在上面、一会儿跑到下面」的根因。现在无条件量算，CSS 只当兜底。 */
  let saved = null;
  try {
    const p = JSON.parse(localStorage.getItem(QF_POS_KEY) || 'null');
    if (p && typeof p.t === 'number') saved = p.t;
  } catch (e) { /* 存档损坏则忽略，走默认落位 */ }
  /* 有存档就在存档高度处夹取；没存档传 0 —— setQuoteFabTop 里 Math.max(lo, 0) = lo，
     正好落到「顶栏底部 + 8」这一最低允许位置（传大值会被上界夹到视口底部，那就错了） */
  setQuoteFabTop(fab, saved == null ? 0 : saved);
  /* 二次校正：字体/图标（SVG 已内联，但字体可能晚到）会让顶栏高度变化，
     等字体就绪后按新高度重算一次，避免仍按首帧的旧高度定位 */
  const reflow = () => {
    if (!fab.style.top) return;
    setQuoteFabTop(fab, parseFloat(fab.style.top) || 0);
  };
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(reflow).catch(() => { /* */ });
  /* 顶栏高度可能因窗口变化、模式徽章增减等变动：直接盯它，一变就跟着调，
     不再依赖「必须滚动一下才会纠正」。
     v3.8.87：导航栏 .tabs 也参与落位基准（吸顶后它压在顶栏之下），同样盯上 ——
     它可能因 flex-wrap 换行而改变高度，不跟就会让悬浮条压住第二行 Tab。 */
  if (window.ResizeObserver) {
    const watch = [document.querySelector('.topbar'), document.querySelector('.tabs')];
    for (const el0 of watch) {
      if (el0) { try { new ResizeObserver(() => { reflow(); }).observe(el0); } catch (e) { /* */ } }
    }
  }

  let dragging = false, moved = false, sy = 0, oy = 0, pid = null;
  fab.addEventListener('pointerdown', (e) => {
    if (e.button) return;
    /* 下拉与按钮必须能被正常点开，按下它们时不进入拖动（只让条身与手柄拖动） */
    if (e.target.closest && e.target.closest('select, button, option')) return;
    dragging = true; moved = false; pid = e.pointerId;
    sy = e.clientY; oy = fab.getBoundingClientRect().top;
    try { fab.setPointerCapture(pid); } catch (err) { /* 老浏览器不支持捕获也不影响拖动 */ }
    e.preventDefault();   /* 顺带屏蔽拖动过程中的原生拖拽与文字选中 */
  });
  fab.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    /* 只认纵向位移：横向一概不理会，条子始终贴右边（3px 以内当手抖，不算拖动） */
    const dy = e.clientY - sy;
    if (!moved && Math.abs(dy) < 3) return;
    moved = true;
    fab.classList.add('dragging');
    setQuoteFabTop(fab, oy + dy);
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    fab.classList.remove('dragging');
    try { fab.releasePointerCapture(pid); } catch (err) { /* */ }
    if (moved) saveQuoteFabPos(fab);   /* 只是点了一下没拖动，就不写存档 */
  };
  fab.addEventListener('pointerup', endDrag);
  fab.addEventListener('pointercancel', endDrag);
  /* 窗口尺寸变化（含手机横竖屏）可能把条子挤出视口，按新高度重新夹取并存档 */
  window.addEventListener('resize', () => {
    if (!fab.style.top) return;
    setQuoteFabTop(fab, parseFloat(fab.style.top) || 0);
    saveQuoteFabPos(fab);
  });
}

export function switchView(name) {
  /* v3.8.37 持仓页 / 自选页已下线：旧会话残留的 sj_view 或历史入口统一回落到总览 */
  if (!$('view-' + name)) name = 'today';
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $('view-' + name).classList.add('active');
  document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  try { localStorage.setItem('sj_view', name); } catch (e) { /* */ }
  /* v3.8.65 切页后总览页可能停在滚动中间位置，需立刻重算悬浮条显隐 */
  syncQuoteFab();
  if (name === 'analysis' && typeof switchAnalysisTab === 'function') {
    if (typeof renderAnalysisSelect === 'function') renderAnalysisSelect();
    if (typeof renderBtOptions === 'function') { try { renderBtOptions(); } catch (e) { /* */ } }
    switchAnalysisTab(typeof anTab !== 'undefined' ? anTab : 'diag');
  }
  /* v3.9.0 切到问答页：重绘一次（消息可能在本页外生成完，DOM 是重建的） */
  if (name === 'qa' && typeof renderQaMessages === 'function') {
    try { renderQaMessages(); renderQaHistory(); qaSyncSendState(); } catch (e) { /* */ }
  }
  /* v3.9.9 切到问答页时同步技能状态条（用户可能刚在设置里改了技能开关 / 妙想 Key） */
  if (name === 'qa' && typeof qaRefreshSkillHint === 'function') {
    try { qaRefreshSkillHint(); } catch (e) { /* */ }
  }
}

/* ============================================================
   分析中心 · 个股诊断（完整迁移自 trade-manager）
   技术面规则引擎（确定性、可复现）+ AI 综合解读（用户点按钮才生成）
   ============================================================ */
/* ---- K 线数据（腾讯为主——浏览器可跨域直连，东财兜底）---- */