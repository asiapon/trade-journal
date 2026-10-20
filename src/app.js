/* ============================================================
   操作日志 · 主应用（自旧版整体移植）
   ── 待拆清单（M3 收尾，逐块抽为正式模块后本文件最终清空删除）：
   [x] storage：rpc/cloudStore/localStore/loadAll/saveSetting/S/环境常量（→ src/storage/gateway.js + core/app-state.js，v0.9.0）
   [x] features/auth：boot/showAuth/doLogin/doLogout/enterApp/switchAuthForm/authMsg（v0.10.0，经 ESM 循环依赖 + ensureCloudLlm 包装解耦）
   [x] features/journal（v0.11.0）
   [x] features/overview（v0.11.0）
   [x] features/qa（v0.11.0）
   [x] features/voice（v0.11.0）
   [x] ui/bind（v0.11.0）
   已拆出：shared/utils · core/netlog · core/stockdict · core/data-layer · sources/quotes
   ============================================================ */
import { $, toast, fmt2, fmtP, fmtPct, pnlCls, esc, fmtTime, nowLocalInput, inferMarket, MKT_NAME } from './shared/utils.js';
import { NetLog, sjTokenHeaders } from './core/netlog.js';
import { StockDict } from './core/stockdict.js';
import { DL } from './core/data-layer.js';
import { emQuote, txQuote } from './sources/quotes.js';
import { TABLES, BACKEND_URL, RPC_BASE, ACCESS_KEY, CLOUD_HOST, rpc, cloudStore, localStore, setStore, loadAll, saveSetting, sessionHooks, storageHooks } from './storage/gateway.js';
import { S } from './core/app-state.js';
import { boot, doLogin, doLogout, showAuth, switchAuthForm, authMsg } from './features/auth.js';
export { doLogin, doLogout, showAuth, switchAuthForm, authMsg } from './features/auth.js';
export { ModelMgr, refreshQuotes } from './features/quotes.js';
export { initQa, renderQaMessages, renderQaHistory, qaSyncSendState, qaBoot } from './features/qa.js';
export { bindEvents, switchView } from './ui/bind.js';
export { renderNetLogUI, renderMe, switchSetPane, loadUsers, renderLogs } from './features/me.js';
export { fetchKlineEast, fetchKlineTx } from './features/diagnose.js';
import { fetchKlineEast, fetchKlineTx, renderAnalysisSelect } from './features/diagnose.js';
import { calcFees, renderTrades } from './features/journal.js';
import { renderMe, renderNetLogUI } from './features/me.js';
import { renderHoldings, renderToday } from './features/overview.js';
import { qaState } from './features/qa.js';
import { ModelMgr, NetQuote, refreshQuotes } from './features/quotes.js';
import { renderWatch } from './features/watchlist.js';
import { bindEvents, switchView } from './ui/bind.js';

/* v0.3.0 M3：行情两源接入 DataLayer——熔断/限流/健康统计/观测统一治理；
   TTL=0，刷新频控仍由 NetQuote 自身 15s 缓存语义负责 */
DL.register('quote:em', { ttl: () => 0, providers: [emQuote] });
DL.register('quote:tx', { ttl: () => 0, providers: [txQuote] });
DL.log = (ok, src, ms, detail) => NetLog.push('quote', src, ok, ms, detail);
/* ============================================================
   操作日志 · 重构版 app.js
   架构：存储适配层（云端 RPC / 本地 localStorage）+ 费用引擎
        + 持仓引擎（移动加权平均）+ 自然语言解析 + 五视图渲染
   ============================================================ */
'use strict';

/* ---------------- 云端配置 ----------------
   云端访问 key 与应用域名绑定（服务端校验 Origin）；
   云端运行走相对路径，本地打开走云端绝对地址，均指向同一后端。

   历史沿革（看代码时容易困惑，按时间顺序）：
     v3.8.63  应用「股票操作日志」wbapp_nRQHqCtwORJYvXyAPTEn0E / trade-journal-94951
     v3.8.64  改前缀需新建应用（平台域名建应用时确定、事后不可改）→
              应用「股票日记」wbapp_mtCmnoJVwocZG4iRlx6CMe / stock-journal-07300
     v0.13.1  stock-journal-07300 退役（首页 404）
     之后    wbapp_QlBVRyRFlasNv8qKmoWHMl / trade-journal-55799
     v3.20.1 上述应用在「设置—数据管理—应用」中被删除，云库一并失效；
              重建为 wbapp_kQybJuiH2NW1ZZKop1t8Wz / trade-journal-81772
              （当前生效值见 src/storage/gateway.js 的 CLOUD_CONFIG）

   换应用后必须同步三处，否则表现为「云服务未启用」：
     gateway.js 的 CLOUD_CONFIG.endpoint / publishableKey / ACCESS_KEY */
export let cloudLlm = null;
function initCloudLlm() {
  if (!window.WorkBuddyCloud) return null;
  try { return WorkBuddyCloud.createWorkBuddyCloud({ endpoint: CLOUD_HOST, publishableKey: ACCESS_KEY }); }
  catch (e) { return null; }
}
/* v3.9.0 新增 qa_history（智能问答历史，云端）。加入 TABLES 后 localStore 的
   清空/读写会一并覆盖，云端则由 app_query/app_insert/app_delete 的白名单放行。 */

/* ---------------- 全局状态 ---------------- */
/* v3.18.4 APP_VER 迁至 core/version.js（stockdict.js 底层模块也要用，此处转出保持兼容） */
import { APP_VER } from './core/version.js';
export { APP_VER };

/* v3.8.44 分组行「动作按钮」图标：与导航图标同一套线框风格（24 格 / 1.6 描边 / 圆角）
   folderPlus = 新建分组，trash = 删除当前分组。v3.8.45 起与短词并排使用。 */
export const ICO = {
  folderPlus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h3.2l1.6 2h9.2A1.5 1.5 0 0 1 20.5 9.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/><path d="M12 11v5.5M9.25 13.75h5.5"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 7h15M9.5 7V5.5a1.5 1.5 0 0 1 1.5-1.5h2a1.5 1.5 0 0 1 1.5 1.5V7M6.9 7l.8 11.4A1.6 1.6 0 0 0 9.3 20h5.4a1.6 1.6 0 0 0 1.6-1.6L17.1 7"/></svg>',
};

/* ============================================================
   全市场股票字典（离线联想：代码 / 名称 / 拼音首字母）
   与 trade-manager 同源数据：stock-dict.json 5573 条全市场
   基础数据随应用发布，localStorage 缓存 7 天；用户数据持续学习。
   ============================================================ */
export function ensureCloudLlm() {
  if (!cloudLlm) { try { cloudLlm = initCloudLlm(); } catch (e) { console.warn('[model] 云端 LLM 初始化失败（自托管部署属正常现象，自定义模型不受影响）'); } }
  return cloudLlm;
}
export function renderAll() {
  renderToday();
  renderHoldings();
  renderTrades();
  renderWatch();
  renderMe();
  /* v3.8.10 分析中心下拉随数据加载刷新：修复启动即落在分析中心时选股框永远"加载中…" */
  if (typeof renderAnalysisSelect === 'function') { try { renderAnalysisSelect(); } catch (e) { /* */ } }
  if (typeof renderBtOptions === 'function') { try { renderBtOptions(); } catch (e) { /* */ } }
}

/* ---------- 今日 ---------- */
/* 今日已实现盈亏：来自各持仓 timeline 的卖出事件（总览「持仓快照」与持仓页共用） */
boot();
globalThis.$ = $;
globalThis.esc = esc;
globalThis.toast = toast;
globalThis.fmt2 = fmt2;
globalThis.fmtP = fmtP;
globalThis.fmtTime = fmtTime;
globalThis.S = S;
globalThis.NetLog = NetLog;
globalThis.NetQuote = NetQuote;
globalThis.StockDict = StockDict;
globalThis.inferMarket = inferMarket;
globalThis.rpc = rpc;
globalThis.sjTokenHeaders = sjTokenHeaders;
globalThis.ModelMgr = ModelMgr;
globalThis.qaState = qaState;
globalThis.fetchKlineEast = fetchKlineEast;
globalThis.fetchKlineTx = fetchKlineTx;
globalThis.refreshQuotes = refreshQuotes;
globalThis.nowLocalInput = nowLocalInput;
globalThis.switchView = switchView;
globalThis.renderAll = renderAll;
globalThis.calcFees = calcFees;
globalThis.renderNetLogUI = renderNetLogUI;