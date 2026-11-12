/* ============================================================
   持仓引擎：移动加权平均（统计权威）+ 摊薄成本（展示）
   v3.22.1 自 journal.js 抽出为纯模块（只依赖 S.trades）：
   ① diagnose/qa/overview/journal 四处共用，本就属于核心域；
   ② 脱离 journal 的重依赖（auth/gateway/DOM）后可在 vitest 里单测。
   v3.23.0 新增持仓基线层 computePositions()：
   「流水推导」覆盖不了非交易引起的持仓变动（转户老仓成本与券商不一致、
   配股送股、券商侧调成本）。基线 = 每只股票一条「截至基线日期收盘的
   真实持仓」（数量 + 成本价，可填 8 位小数与券商 APP 对齐）：
   - 基线日期之后的交易流水照常自动更新持仓；
   - 基线日期当天及更早的流水不再参与持仓推导（基线已含它们）；
   - 历史统计（按股票统计/当笔盈亏/今日已实现）仍走 computeHoldings()，
     改基线不会改写历史。
   ============================================================ */
import { S } from './app-state.js';

/* 本地交易日 YYYY-MM-DD（与交易时间的本地日期对齐，不用 UTC） */
function dayKeyOf(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* 读取基线（存于 settings 表 pos_base 键，本地/云端同一通道） */
export function posBases() {
  const v = S.settings && S.settings.pos_base;
  return Array.isArray(v) ? v.filter(b => b && b.stock_code) : [];
}

function newHold(code, base) {
  const h = { code, name: '', market: '', qty: 0, costValue: 0, dilutedValue: 0, realized: 0, realizedOp: 0, timeline: [], dayKey: '', dayQty: 0, dayCost: 0 };
  if (base) {
    h.isBase = true;
    h.baseDate = base.base_date || '';
    h.baseQty = Number(base.qty) || 0;
    h.baseCost = Number(base.costPrice) || 0;   // 不做小数位截断：券商成本价最多 8 位小数
    h.name = base.stock_name || '';
    h.market = base.market || '';
    h.qty = h.baseQty;
    h.costValue = h.baseQty * h.baseCost;
    h.dilutedValue = h.baseQty * h.baseCost;    // 摊薄口径在基线点与加权重合
  }
  return h;
}

/* 单笔交易对持仓的作用（computeHoldings / computePositions 共用同一套算法） */
function applyTrade(h, t) {
  if (t.stock_name) h.name = t.stock_name;
  if (t.market) h.market = t.market;
  const feeTotal = (t.fee && t.fee.total) || 0;
  const net = t.net_amount != null ? Number(t.net_amount) : t.gross_amount - feeTotal;
  /* 日切：换了一天就清空配对池（按该笔自身的交易日期，逐股票独立判断）
     v3.22.1 修复：配对池此前是全局单变量（dayKey/dayQty/dayCost 不分股票），
     同一天买过 A、卖过 B 时，B 的卖出会错误地配上 A 的买入成本。
     现挂在 holding 对象上（h.dayKey/h.dayQty/h.dayCost），逐股票隔离。 */
  const tKey = dayKeyOf(t.transaction_time);
  if (tKey !== h.dayKey) { h.dayKey = tKey; h.dayQty = 0; h.dayCost = 0; }
  if (t.transaction_type === 'buy') {
    h.qty += t.quantity;
    h.costValue += t.gross_amount + feeTotal;      // 加权：费用计入成本
    h.dilutedValue += t.gross_amount + feeTotal;
    h.dayQty += t.quantity; h.dayCost += t.gross_amount + feeTotal;
    h.timeline.push({ t, avg: h.qty ? h.costValue / h.qty : 0, realized: null, realizedOp: null });
  } else {
    const avg = h.qty ? h.costValue / h.qty : 0;
    const pnl = net - t.quantity * avg;            // 整轮口径：这笔卖 vs 持仓加权成本
    h.realized += pnl;
    /* 当笔口径：先用当日买入池配对，剩余部分再用历史加权成本
       （v3.8.56 做 T 时「已实现盈亏」反映这一手操作的真实收益，
       而不是拿隔夜老仓的高成本去比） */
    let pnlOp;
    if (h.dayQty > 0) {
      const useQty = Math.min(t.quantity, h.dayQty);
      const avgDay = h.dayCost / h.dayQty;
      pnlOp = useQty * ((net / t.quantity) - avgDay); // 配对部分：卖出净价 − 当日买入成本
      h.dayCost -= useQty * avgDay; h.dayQty -= useQty;
      const rest = t.quantity - useQty;
      if (rest > 0) pnlOp += rest * ((net / t.quantity) - avg);
    } else {
      pnlOp = pnl;
    }
    h.realizedOp += pnlOp;
    h.costValue -= t.quantity * avg;
    h.dilutedValue -= net;                          // 摊薄：盈亏滚入
    h.qty -= t.quantity;
    if (h.qty <= 0.0001) { h.qty = 0; h.costValue = 0; h.dilutedValue = 0; }
    h.timeline.push({ t, avg, realized: pnl, realizedOp: pnlOp });
  }
}

function sortedTrades() {
  return [...S.trades].sort((a, b) => new Date(a.transaction_time) - new Date(b.transaction_time));
}

/* 纯流水推导（历史统计的权威口径，不 吃基线） */
export function computeHoldings() {
  const map = new Map();
  for (const t of sortedTrades()) {
    if (!map.has(t.stock_code)) map.set(t.stock_code, newHold(t.stock_code));
    applyTrade(map.get(t.stock_code), t);
  }
  return [...map.values()];
}

/* 基线优先的当前持仓：持仓页/总览页展示用 */
export function computePositions() {
  const bases = posBases();
  if (!bases.length) return computeHoldings();   // 无基线 = 与纯流水完全一致
  const map = new Map();
  const baseByCode = new Map();
  for (const b of bases) {
    map.set(b.stock_code, newHold(b.stock_code, b));
    baseByCode.set(b.stock_code, b);
  }
  for (const t of sortedTrades()) {
    const b = baseByCode.get(t.stock_code);
    /* 基线表示「截至基线日期收盘」：当天及更早的流水已含在基线里，跳过 */
    if (b && dayKeyOf(t.transaction_time) <= b.base_date) continue;
    if (!map.has(t.stock_code)) map.set(t.stock_code, newHold(t.stock_code));
    applyTrade(map.get(t.stock_code), t);
  }
  return [...map.values()];
}
