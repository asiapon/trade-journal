/* ============================================================
   持仓引擎：移动加权平均（统计权威）+ 摊薄成本（展示）
   v3.22.1 自 journal.js 抽出为纯模块（只依赖 S.trades）：
   ① diagnose/qa/overview/journal 四处共用，本就属于核心域；
   ② 脱离 journal 的重依赖（auth/gateway/DOM）后可在 vitest 里单测。
   ============================================================ */
import { S } from './app-state.js';

export function computeHoldings() {
  const map = new Map();
  const sorted = [...S.trades].sort((a, b) => new Date(a.transaction_time) - new Date(b.transaction_time));
  /* v3.8.56 当日配对池：卖出时优先用「同日买入」的成本配对，剩余部分才回落到历史持仓成本。
     目的：做 T（当日买、当日卖）时「已实现盈亏」反映这一手操作的真实收益，
     而不是拿隔夜老仓的高成本去比（那会得出与直觉相反的巨额亏损）。
     dayKey = 本地交易日 YYYY-MM-DD，日切时重置池。
     v3.22.1 修复：配对池此前是全局单变量（dayKey/dayQty/dayCost 不分股票），
     同一天买过 A、卖过 B 时，B 的卖出会错误地配上 A 的买入成本——
     实测：当日买长城 11.20 + 买另一只 38 元股，卖出长城的「当笔盈亏」
     被算成 -6,633.89（配对均价被抬到 24.77）。现改为按 stock_code 各自隔离，
     挂在 holding 对象上（h.dayKey/h.dayQty/h.dayCost）。 */
  for (const t of sorted) {
    const k = t.stock_code;
    if (!map.has(k)) map.set(k, { code: k, name: t.stock_name || '', market: t.market, qty: 0, costValue: 0, dilutedValue: 0, realized: 0, realizedOp: 0, timeline: [], dayKey: '', dayQty: 0, dayCost: 0 });
    const h = map.get(k);
    if (t.stock_name) h.name = t.stock_name;
    if (t.market) h.market = t.market;
    const feeTotal = (t.fee && t.fee.total) || 0;
    const net = t.net_amount != null ? Number(t.net_amount) : t.gross_amount - feeTotal;
    /* 日切：换了一天就清空配对池（按该笔自身的交易日期，逐股票独立判断） */
    const d = new Date(t.transaction_time);
    const tKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
      /* 当笔口径：先用当日买入池配对，剩余部分再用历史加权成本 */
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
  return [...map.values()];
}
