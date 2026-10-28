/* 总览域：今日统计 / 持仓渲染（移动加权平均）（v0.11.0 自单体拆出） */
import { $, toast, fmt2, fmtP, fmtPct, pnlCls, esc, fmtTime, nowLocalInput, inferMarket, MKT_NAME } from '../shared/utils.js';
import { NetLog, sjTokenHeaders } from '../core/netlog.js';
import { StockDict } from '../core/stockdict.js';
import { DL } from '../core/data-layer.js';
import { emQuote, txQuote } from '../sources/quotes.js';
import { TABLES, BACKEND_URL, RPC_BASE, ACCESS_KEY, CLOUD_HOST, rpc, cloudStore, localStore, setStore, loadAll, saveSetting, sessionHooks, storageHooks } from '../storage/gateway.js';
import { S } from '../core/app-state.js';
import { U } from '../core/ui-state.js';
import { computeHoldings, quoteMap } from './journal.js';
import { NetQuote } from './quotes.js';
import { updateSortHead } from './watchlist.js';

export function todayRealizedPnl() {
  const todayStr = new Date().toDateString();
  let s = 0;
  for (const h of computeHoldings()) {
    for (const ev of h.timeline) {
      if (ev.realized != null && new Date(ev.t.transaction_time).toDateString() === todayStr) s += ev.realized;
    }
  }
  return s;
}
export function renderToday() {
  /* v3.8.46 总览页收敛为「大盘指数 / 持仓信息 / 自选列表」三个数据卡，
     原「快捷记一笔」「近期操作」两张卡已下线（记一笔入口在持仓信息卡与交易记录页，
     近期操作去交易记录页看）。这里只剩演示数据提示。 */
  const sh = $('seedHint');
  if (sh) sh.hidden = S.trades.length > 0;
}

/* ---------- 持仓 ---------- */
export const WB_COLORS = ['#3468D6', '#D93A2B', '#0E9463', '#B7791F', '#7C5CBF', '#2E9AA8', '#C2557A', '#6B7280'];

/* ============================================================
   v3.8.34 持仓 / 自选模块的「挂载点」配置
   渲染逻辑与 DOM 挂载点解耦，只是 DOM 挂载点不同。
   —— v3.8.37 持仓页 / 自选页已下线，仅保留总览页挂载点；
      若日后需要再开专页，加回一条 HTML 区块 + 这里一条即可。
   ============================================================ */
export const HOLD_MOUNTS = [
  { pc: 'tvHoldTable', mobile: 'tvHoldTableM', summary: 'tvHoldSummary', empty: 'tvHoldEmpty', recBtn: 'tvHoldEmptyRec', ext: true },
];
export const WATCH_MOUNTS = [
  { root: 'view-today', form: 'tvWatchForm', input: 'tvWfInput', sug: 'tvWfSug', note: 'tvWfNoteQuick', group: 'tvWfGroupQuick',
    submit: 'tvWfSubmit', cancel: 'tvWfCancel', tabs: 'tvWatchTabs', table: 'tvWatchTable', empty: 'tvWatchEmpty', delGroup: 'tvDelGroupBtn',
    toggle: 'tvWatchAddBtn' },   /* v3.8.78 标题行「＋ 加自选」= 开弹窗入口（原折叠开关） */
];
export function renderHoldings() {
  const all = computeHoldings();
  const qm = quoteMap();
  const NA = '<span class="na-tag">未获取</span>';

  /* 当日交易按代码分组（当日盈亏与今日清仓都要用） */
  const todayStr = nowLocalInput().slice(0, 10);
  const todayByCode = new Map();
  for (const t of S.trades) {
    if (t.source === 'init') continue; /* 初始化持仓不进当日交易 */
    if (t.transaction_time.slice(0, 10) !== todayStr) continue;
    if (!todayByCode.has(t.stock_code)) todayByCode.set(t.stock_code, []);
    todayByCode.get(t.stock_code).push(t);
  }
  /* 持仓表：正常持仓 + 今日清仓的股票（清仓当日保留展示，盈亏已落地） */
  const holds = all.filter(h => h.qty > 0 || (todayByCode.get(h.code) || []).some(t => t.transaction_type === 'sell'));
  /* 当日盈亏（券商口径）：卖出净得 + 期末持仓现价 − 买入净额 − 期初持仓×昨收
     净额含费用；期初持仓 = 期末 + 今日卖出 − 今日买入。对「今日买今日卖」做 T 与「今日清仓」均成立。
     v3.8.55 修复：只要拿得到「现价 + 昨收」，没有今日交易也应当能算出当日盈亏
     （= 期末持仓 × 现价 − 期末持仓 × 昨收），此前 `if (!tt.length) return null` 把
     无交易的日子一律判成「未获取」，所以老基线持仓永远看不到当日盈亏。 */
  function dayPnlOf(code, endQty, price, prevClose) {
    const tt = todayByCode.get(code) || [];
    if (!tt.length) {
      /* 无今日交易：纯隔夜持仓的当日盈亏 = 期末持仓 × (现价 − 昨收) */
      if (price == null || !(prevClose > 0) || endQty <= 0) return null;
      return endQty * (price - prevClose);
    }
    let buyNet = 0, buyQty = 0, sellNet = 0, sellQty = 0;
    for (const t of tt) {
      const f = (t.fee && t.fee.total) || 0;
      if (t.transaction_type === 'buy') { buyQty += t.quantity; buyNet += t.net_amount != null ? Number(t.net_amount) : t.gross_amount + f; }
      else { sellQty += t.quantity; sellNet += t.net_amount != null ? Number(t.net_amount) : t.gross_amount - f; }
    }
    const openQty = endQty + sellQty - buyQty;               // 期初（昨收时点）持仓
    if (!price && openQty <= 0) return sellNet - buyNet;     // 今买今卖全平，无行情也能算
    if (price == null || !(prevClose > 0)) return null;      // 隔夜部分缺昨收无法算
    return sellNet + endQty * price - buyNet - openQty * prevClose;
  }
  const rows = holds.map((h, i) => {
    const q = qm.get(h.code);
    const price = q ? q.price : null;
    const prevClose = q ? q.prevClose : null;
    const cleared = h.qty <= 0;                               // 今日清仓：保留展示，盈亏已落地
    /* 摊薄成本：持仓股=当前摊薄；清仓股=清仓前最后一笔的加权成本（不再平摊，保留作参考） */
    const costPrice = h.qty ? h.dilutedValue / h.qty
      : (h.timeline && h.timeline.length ? h.timeline[h.timeline.length - 1].avg : null);
    const mv = !cleared && price != null ? h.qty * price : null;
    const dayPnl = dayPnlOf(h.code, h.qty, price, prevClose);
    /* 清仓股盈亏列 = 该股全部已实现盈亏（整轮结果，vs 成本）；持仓股 = 摊薄累计盈亏 */
    const float = cleared ? (h.realized || 0) : (price != null ? h.qty * price - h.dilutedValue : null);
    const floatPct = !cleared && price != null && costPrice ? float / h.dilutedValue : null;
    const dayPct = price != null && prevClose > 0 ? (price - prevClose) / prevClose : null;
    return { h, cleared, price, prevClose, costPrice, mv, float, floatPct, dayPnl, dayPct, color: WB_COLORS[i % WB_COLORS.length] };
  });
  /* 今日清仓股的落地盈亏（已在 rows 中） */

  /* 持仓统计卡：摊薄口径，与表格行完全一致（浮动盈亏=累计盈亏，当日参考盈亏=券商口径） */
  let totalMV = 0, totalDayPnl = 0;
  for (const r of rows) {
    if (r.mv != null) { totalMV += r.mv; if (r.dayPnl != null) totalDayPnl += r.dayPnl; }
  }
  /* 今日清仓股的已落地盈亏计入当日参考盈亏 */
  totalDayPnl += rows.filter(r => r.cleared).reduce((s, r) => s + (r.dayPnl != null ? r.dayPnl : 0), 0);
  /* v3.8.23 持仓表头三态排序（与自选表一致）：降序→升序→取消，空值恒排最后 */
  if (U.holdSort.key && U.holdSort.dir) {
    const getter = {
      mv: r => r.mv, float: r => r.float, floatPct: r => r.floatPct,
      qty: r => r.cleared ? 0 : r.h.qty, cost: r => r.costPrice, price: r => r.price,
      dayPnl: r => r.dayPnl, dayPct: r => r.dayPct
    }[U.holdSort.key];
    if (getter) {
      rows.sort((a, b) => {
        const va = getter(a), vb = getter(b);
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        return (vb - va) * U.holdSort.dir;
      });
    }
  }
  updateSortHead('#tvHoldTable', U.holdSort);
  /* 报价时间提示（持仓页 + 总览页同步）
     v3.9.20 修复「指数有数、下面却写着行情未获取」的自相矛盾：
     空账户（无持仓 + 无自选）时 merged.size === 0，quotes.js 里
     `if (merged.size)` 把关，quoteTime 永远不会被赋值；而 fetchIdx()
     是独立链路，照样把 6 个指数拉回来 → 屏幕上指数有价、提示说没拿到。
     现在按「拿到哪一份就说哪一份」。 */
  const hms = ts => {
    const d = new Date(ts), p = n => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const qtiTxt = NetQuote.quoteTime
    ? `行情报价时间 ${NetQuote.quoteTime}（${NetQuote.eastDeadUntil > Date.now() ? '腾讯备源' : '东财主源'}，缓存15秒）`
    : (NetQuote.idxTime
      ? `指数更新于 ${hms(NetQuote.idxTime)} · 自选/持仓报价未获取`
      : '行情未获取 · 点上方「刷新行情」重试');
  /* v3.8.37 持仓页下线：报价时间/指数条只有总览页一处挂载点 */
  ['tvQuoteTime'].forEach(id => {
    const el = document.getElementById(id); if (el) el.textContent = qtiTxt;
  });
  /* v3.8.26 指数条（红涨绿跌）；v3.8.62 起为 6 枚：上证指数 / 深证成指 / 创业板指
     + 沪深300 / 中证500 / 中证1000（大中小盘宽基），全部由 NetQuote.INDEXES 驱动
     v3.8.69 手机端补「涨跌额」：窄屏每行一枚胶囊、右侧余量很大（实测 360px 下
     内容仅占 296px / 可用 332px），而原来只有百分比、看不到具体涨跌多少个点。
     v3.8.70 涨跌额改为**并入百分比括号内**（-0.74%(-28.19)）：原先它是第 4 枚
     独立 span（.i-chg），自带 5.5em 定宽右对齐，实测在百分比后隔出 35.8px 空隙，
     用户反馈「中间隔的空太多」。合并后不再需要独立列，定宽与空隙一并消失。
     括号段字号比主数值小一档（12px）、跟随涨跌着色，保持「补充信息」的主次。
     仍在窄屏才加：PC 端一行排 6 枚，多一段数值会把它们挤到换行。 */
  const idxNarrow = window.matchMedia('(max-width: 720px)').matches;
  const idxItems = NetQuote.INDEXES.map(ix => {
    const q = NetQuote.idx.get(ix.sym);
    if (!q || !(q.price > 0)) return '';
    const cls = q.pct >= 0 ? 'up' : 'down';
    const sign = q.pct >= 0 ? '+' : '';
    /* v3.8.70 涨跌额并进百分比（括号形式）；涨跌额缺失（个别源不返回）时只显示百分比 */
    const chgTxt = (idxNarrow && q.chg != null && !isNaN(q.chg))
      ? `<span class="i-chg">(${q.chg >= 0 ? '+' : ''}${fmt2(q.chg)})</span>` : '';
    return `<span class="idx-chip ${cls}"><span class="i-name">${esc(q.name || ix.name)}</span><span class="i-val">${fmt2(q.price)}</span><span class="i-pct">${sign}${q.pct.toFixed(2)}%</span>${chgTxt}</span>`;
  }).join('');
  ['tvIdxBar'].forEach(id => {
    const el = document.getElementById(id); if (!el) return;
    el.hidden = !idxItems; el.innerHTML = idxItems;
  });
  const totalFloat = rows.reduce((s, r) => s + (r.float != null ? r.float : 0), 0);
  /* v3.8.38 总览页「持仓快照」统计：3 项，聚焦当前持仓本身
     （账户级「总市值/累计盈亏」已下线——那类口径可从「交易记录」统计得到）
     沿用与「大盘指数」同款胶囊，容器加 .idx-bar-eq 做等宽网格：PC 一行 / 手机两行 */
  const missingQty = rows.filter(r => !r.cleared && r.price == null).length;
  const sSgn = v => (v >= 0 ? '+' : '');
  const sCls = v => (v > 0 ? 'up' : v < 0 ? 'down' : '');
  const sPct = (v, base) => (base > 0 ? sSgn(v) + (v / base * 100).toFixed(2) + '%' : '');
  const statChip = (name, val, cls, pct) => `<span class="idx-chip${cls ? ' ' + cls : ''}">`
    + `<span class="i-name">${name}</span><span class="i-val">${val}</span>`
    + (pct ? `<span class="i-pct">${pct}</span>` : '') + '</span>';
  /* v3.8.75 去掉「持仓市值」的 ¥ 前缀：胶囊里已经有「持仓市值」这个语义标签，
     同一行其余两项（浮动盈亏/当日盈亏）也都是纯数字，带符号不带上限单位，
     保留 ¥ 反而让三项基线不齐、宽度被撑开。 */
  const tvStatsHtml = statChip('持仓市值', fmt2(totalMV), '', '')
    + statChip('浮动盈亏', sSgn(totalFloat) + fmt2(totalFloat), sCls(totalFloat), sPct(totalFloat, totalMV - totalFloat))
    + statChip('当日盈亏', sSgn(totalDayPnl) + fmt2(totalDayPnl), sCls(totalDayPnl), sPct(totalDayPnl, totalMV - totalDayPnl))
    + (missingQty ? `<span class="hold-warn">${missingQty} 只现价未获取</span>` : '');
  const sumHtmlOf = () => (rows.length ? tvStatsHtml : '');

  /* PC 全列表格：股票/市值/盈亏/盈亏%/数量/成本价/现价/当日盈亏/当日盈亏%
     （v3.8.50：「持仓/可用」改为「数量」——本表只是交易日志的持仓汇总，
      不存在「当日买入不可卖」的交易约束，故不再区分可用；「仓位」列一并下线，
      因为没有账户总资产口径，单股占比没有意义） */
  const pcHtml = rows.map(r => {
    const { h, price, costPrice, mv, float, floatPct, dayPnl, dayPct } = r;
    return `<tr data-code="${esc(h.code)}">
      <td><div class="stock-cell"><span class="sc-name">${esc(h.name || h.code)}${r.cleared ? ' <span class="tag cleared">已清仓</span>' : ''}</span><span class="sc-code">${esc(h.code)}</span></div></td>
      <td class="num">${mv != null ? fmt2(mv) : NA}</td>
      <td class="num ${float != null ? pnlCls(float) : ''}">${float != null ? (float >= 0 ? '+' : '') + fmt2(float) : NA}</td>
      <td class="num ${floatPct != null ? pnlCls(floatPct) : ''}">${floatPct != null ? fmtPct(floatPct) : NA}</td>
      <td class="num">${h.qty}</td>
      <td class="num">${costPrice != null ? fmtP(costPrice) : '—'}</td>
      <td class="num price-cell">${price != null ? fmt2(price) : NA}</td>
      <td class="num ${dayPnl != null ? pnlCls(dayPnl) : ''}">${dayPnl != null ? (dayPnl >= 0 ? '+' : '') + fmt2(dayPnl) : NA}</td>
      <td class="num ${dayPct != null ? pnlCls(dayPct) : ''}">${dayPct != null ? fmtPct(dayPct) : NA}</td>
    </tr>`;
  }).join('');

  /* 手机端合并列表格：市值(含股票信息) / 盈亏 / 数量 / 成本现价 / 当日盈亏
     （v3.8.50：市值列不再重复显示股票代码 → 名称 + 市值两行） */
  const mobileHtml = rows.map(r => {
    const { h, price, costPrice, mv, float, floatPct, dayPnl, dayPct } = r;
    const sgn = v => (v >= 0 ? '+' : '');
    return `<tr data-code="${esc(h.code)}">
      <td><div class="stock-cell"><span class="sc-name">${esc(h.name || h.code)}${r.cleared ? ' <span class="tag cleared">已清仓</span>' : ''}</span><span class="sc-mv">${mv != null ? fmt2(mv) : NA}</span></div></td>
      <td class="num"><div class="two-line"><b class="${float != null ? pnlCls(float) : ''}">${float != null ? sgn(float) + fmt2(float) : NA}</b><span class="sub ${floatPct != null ? pnlCls(floatPct) : ''}">${floatPct != null ? fmtPct(floatPct) : ''}</span></div></td>
      <td class="num">${h.qty}</td>
      <td class="num"><div class="two-line"><span>${costPrice != null ? fmtP(costPrice) : '—'}</span><span class="sub">${price != null ? fmt2(price) : '未获取'}</span></div></td>
      <td class="num"><div class="two-line"><b class="${dayPnl != null ? pnlCls(dayPnl) : ''}">${dayPnl != null ? sgn(dayPnl) + fmt2(dayPnl) : NA}</b><span class="sub ${dayPct != null ? pnlCls(dayPct) : ''}">${dayPct != null ? fmtPct(dayPct) : ''}</span></div></td>
    </tr>`;
  }).join('');

  /* v3.8.34 总览页与持仓页共用同一份渲染结果（挂载点见 HOLD_MOUNTS，删页只需去掉对应条目） */
  for (const m of HOLD_MOUNTS) {
    const pcEl = document.getElementById(m.pc);
    if (pcEl) pcEl.querySelector('tbody').innerHTML = pcHtml;
    const mbEl = document.getElementById(m.mobile);
    if (mbEl) mbEl.querySelector('tbody').innerHTML = mobileHtml;
    const sumEl = document.getElementById(m.summary);
    if (sumEl) sumEl.innerHTML = sumHtmlOf();
    const emptyEl = document.getElementById(m.empty);
    if (emptyEl) emptyEl.hidden = holds.length > 0;
  }
}

/* ---------- 操作（交易） ---------- */
/* 展开的费用明细行 id 集合：重渲染后恢复，仅再次点击才收起 */
export const feeOpenIds = new Set();
/* 按股票视图：展开状态与最近一次聚合数据 */
export let stockOpenCodes = new Set();
export function stockDetailRow(g) {
  const list = [...g.trades].sort((a, b) => new Date(a.transaction_time) - new Date(b.transaction_time));
  const holdByCode = new Map();
  for (const h of computeHoldings()) holdByCode.set(h.code, h);
  let realizedSum = 0, realizedOpSum = 0;
  const items = list.map(t => {
    const fee = (t.fee && t.fee.total) || 0;
    const d = new Date(t.transaction_time), p = n => String(n).padStart(2, '0');
    return { t, fee, dateStr: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`, pnl: null, pnlOp: null };
  });
  /* 从 timeline 拿每笔卖出已实现盈亏（整轮口径 + 当笔配对口径） */
  const tlMap = new Map(), tlMapOp = new Map();
  for (const ev of (holdByCode.get(g.code) || { timeline: [] }).timeline) {
    if (ev.realized != null && ev.t) tlMap.set(String(ev.t.id), ev.realized);
    if (ev.realizedOp != null && ev.t) tlMapOp.set(String(ev.t.id), ev.realizedOp);
  }
  for (const it of items) {
    it.pnl = tlMap.has(String(it.t.id)) ? tlMap.get(String(it.t.id)) : null;
    it.pnlOp = tlMapOp.has(String(it.t.id)) ? tlMapOp.get(String(it.t.id)) : null;
    if (it.pnl != null) realizedSum += it.pnl;
    if (it.pnlOp != null) realizedOpSum += it.pnlOp;
  }
  /* v3.8.27 浮动盈亏改用加权成本口径：与期间已实现互斥，避免摊薄口径重复计入已实现盈利
     （摊薄口径的浮动已把卖出盈利滚入成本，若再与 realizedSum 相加会重复） */
  const h = holdByCode.get(g.code);
  const q = quoteMap().get(g.code);
  const floatNow = h && h.qty > 0 && q && q.price != null ? h.qty * q.price - h.costValue : 0;
  const holdingNote = h && h.qty > 0 ? `期末仍持有 ${h.qty} 股，浮动 ${floatNow >= 0 ? '+' : ''}${fmt2(floatNow)}` : '该股已清仓，盈亏全部落地';
  const total = realizedSum + floatNow;
  /* v3.8.29 展开区顶部加持仓明细卡同款 4 卡（全历史口径，与持仓页明细卡数字一致可互验） */
  const has = !!h;
  const costW = has && h.qty ? h.costValue / h.qty : 0;
  const costD = has && h.qty ? h.dilutedValue / h.qty : 0;
  const price = q && q.price != null ? Number(q.price) : null;
  /* v3.8.51 展开区统计改为与总览「大盘 / 持仓」同款胶囊（同字号 13px、同内距与圆角）
     期间口径（期间已实现 / 期间总盈亏）收进胶囊副文，原底部 sd-sum 汇总行随之下线 */
  const sdChip = (name, val, cls, sub) => `<span class="idx-chip${cls ? ' ' + cls : ''}">`
    + `<span class="i-name">${name}</span><span class="i-val">${val}</span>`
    + (sub ? `<span class="i-sub">${sub}</span>` : '') + '</span>';
  const sdSign = v => (v >= 0 ? '+' : '');
  const sdCls = v => (v > 0 ? 'up' : v < 0 ? 'down' : '');
  const chips = `
    <div class="idx-bar idx-bar-lg sd-chips">
      ${sdChip('持仓', has && h.qty ? h.qty + ' 股' : '已清仓', '', price != null ? '现价 ' + fmt2(price) : '现价未获取')}
      ${sdChip('成本', has && h.qty ? fmtP(costW) + ' / ' + fmtP(costD) : '—', '', '加权 / 摊薄')}
      ${sdChip('累计已实现', has ? sdSign(h.realized) + fmt2(h.realized) : '—', sdCls(has ? h.realized : 0), '期间 ' + sdSign(realizedSum) + fmt2(realizedSum))}
      ${sdChip('当笔盈亏', sdSign(realizedOpSum) + fmt2(realizedOpSum), sdCls(realizedOpSum), '卖出配当日买入')}
      ${sdChip('浮动盈亏', sdSign(floatNow) + fmt2(floatNow), sdCls(floatNow), '期间总盈亏 ' + sdSign(total) + fmt2(total))}
    </div>`;
  return `<tr class="stock-detail-row"><td colspan="6">
    <div class="sd-title">${esc(g.name)}（${esc(g.code)}）筛选期间共 ${list.length} 笔 · ${holdingNote}</div>
    ${chips}
    ${list.length ? `<div class="sd-tbl-scroll">
      <table class="sd-tbl">
        <thead><tr><th>时间</th><th>方向</th><th class="num">价格</th><th class="num">数量</th><th class="num">成交金额</th><th class="num">费用</th><th class="num">当笔盈亏</th><th class="num">累计已实现</th></tr></thead>
        <tbody>
          ${items.map(it => `<tr>
            <td>${it.dateStr}</td>
            <td><span class="tag ${it.t.transaction_type}">${it.t.transaction_type === 'buy' ? '买入' : '卖出'}</span></td>
            <td class="num">${fmt2(it.t.price)}</td>
            <td class="num">${it.t.quantity}</td>
            <td class="num">${fmt2(it.t.gross_amount)}</td>
            <td class="num">${fmt2(it.fee)}</td>
            <td class="num ${it.pnlOp != null ? pnlCls(it.pnlOp) : ''}">${it.pnlOp != null ? (it.pnlOp >= 0 ? '+' : '') + fmt2(it.pnlOp) : '—'}</td>
            <td class="num ${it.pnl != null ? pnlCls(it.pnl) : ''}">${it.pnl != null ? (it.pnl >= 0 ? '+' : '') + fmt2(it.pnl) : '—'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>` : '<div class="empty" style="padding:10px">筛选期间无操作记录（持仓/盈亏见上方卡片）</div>'}
  </td></tr>`;
}