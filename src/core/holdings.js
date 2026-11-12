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
   v3.23.3 基线存储并入 positions 表（is_base=1 行 + base_qty/base_cost 快照列），
   settings.pos_base 中转层退役；读取入口 posBases() 对新旧存储做了透明兼容。
   ============================================================ */
import { S } from './app-state.js';

/* 本地交易日 YYYY-MM-DD（与交易时间的本地日期对齐，不用 UTC） */
function dayKeyOf(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* 读取基线。v3.23.3 起基线直接存 positions 表（is_base=1 行）：
   base_qty/base_cost 是「基线日期收盘」的数量/成本快照（券商成本价最多 8 位小数），
   行上的 qty/cost_price 则是基线叠加后续流水后的当前值——两层含义分开存，
   settings.pos_base（v3.23.0 的中转存储）退役，boot 时自动迁移并删键。
   旧后端无 positions 表（S.positionsOk=false）时回落读 settings.pos_base。 */
export function posBases() {
  if (S.positionsOk !== false && Array.isArray(S.positions)) {
    return S.positions
      .filter(r => r && r.is_base && r.base_qty != null)
      .map(r => ({ stock_code: r.stock_code, stock_name: r.stock_name, market: r.market, qty: r.base_qty, costPrice: r.base_cost, base_date: r.base_date || '' }));
  }
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

/* 基线优先的当前持仓：持仓页/总览页展示用
   v3.23.2 支持单股重放 computePositions(code)：增量同步 positions 表用，
   只重放该股流水（通常几十笔），全量重放只留给 boot/导入后的校准。 */
export function computePositions(code) {
  const trades = code ? S.trades.filter(t => t.stock_code === code) : S.trades;
  const bases = posBases();
  if (!bases.length) {
    const map = new Map();
    for (const t of [...trades].sort((a, b) => new Date(a.transaction_time) - new Date(b.transaction_time))) {
      if (!map.has(t.stock_code)) map.set(t.stock_code, newHold(t.stock_code));
      applyTrade(map.get(t.stock_code), t);
    }
    return [...map.values()];
  }
  const map = new Map();
  const baseByCode = new Map();
  for (const b of bases) {
    if (code && b.stock_code !== code) continue;
    map.set(b.stock_code, newHold(b.stock_code, b));
    baseByCode.set(b.stock_code, b);
  }
  for (const t of [...trades].sort((a, b) => new Date(a.transaction_time) - new Date(b.transaction_time))) {
    const b = baseByCode.get(t.stock_code);
    /* 基线表示「截至基线日期收盘」：当天及更早的流水已含在基线里，跳过 */
    if (b && dayKeyOf(t.transaction_time) <= b.base_date) continue;
    if (!map.has(t.stock_code)) map.set(t.stock_code, newHold(t.stock_code));
    applyTrade(map.get(t.stock_code), t);
  }
  return [...map.values()];
}

/* ============================================================
   v3.23.2 positions 表（持仓实体）的行映射与差异比较
   positions 是「当前持仓」的持久化状态：每笔交易/基线变动后
   增量 upsert（没有就 INSERT，有就 UPDATE），UI 与导出直接读表。
   ============================================================ */

/* holding → positions 表行（纯数据，无 id/owner_id/updated_at）。
   cost_price：持仓股 = 摊薄成本；清仓股 = 清仓前最后一笔加权成本（保留参考）。
   base_qty/base_cost：仅基线行（is_base=1）写入基线点快照，普通行为 NULL。 */
export function positionRowOf(h) {
  const lastAvg = h.timeline && h.timeline.length ? h.timeline[h.timeline.length - 1].avg : null;
  return {
    stock_code: h.code,
    stock_name: h.name || '',
    market: h.market || '',
    qty: h.qty,
    cost_price: h.qty > 0 ? h.dilutedValue / h.qty : lastAvg,
    cost_value: h.costValue,
    diluted_cost: h.dilutedValue,
    realized: h.realized || 0,
    realized_op: h.realizedOp || 0,
    is_base: h.isBase ? 1 : 0,
    base_date: h.baseDate || null,
    base_qty: h.isBase ? h.baseQty : null,
    base_cost: h.isBase ? h.baseCost : null
  };
}

/* 现有表行 vs 目标行是否需要 UPDATE（忽略 id/owner_id/updated_at；浮点按 1e-8 容差）。
   base_qty/base_cost 必须参与比较：基线快照变了（维护持仓改数）才不会漏更。 */
export function positionNeedsUpdate(row, rec) {
  const ne = (a, b) => (a == null ? 2 : 0) !== (b == null ? 2 : 0) || (a != null && Math.abs(Number(a) - Number(b)) > 1e-8);
  return row.stock_name !== rec.stock_name || row.market !== rec.market
    || ne(row.qty, rec.qty) || ne(row.cost_price, rec.cost_price)
    || ne(row.cost_value, rec.cost_value) || ne(row.diluted_cost, rec.diluted_cost)
    || ne(row.realized, rec.realized) || ne(row.realized_op, rec.realized_op)
    || (!!row.is_base !== !!rec.is_base) || (row.base_date || null) !== rec.base_date
    || ne(row.base_qty, rec.base_qty) || ne(row.base_cost, rec.base_cost);
}
