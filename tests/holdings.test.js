import { describe, it, expect, beforeEach } from 'vitest';
import { computeHoldings } from '../src/core/holdings.js';
import { S } from '../src/core/app-state.js';

/* 交易记录最小构造：费用显式置 0，聚焦配对与盈亏口径本身 */
let idSeq = 0;
function tr(type, code, price, qty, time, extra = {}) {
  const gross = price * qty;
  return {
    id: ++idSeq, transaction_type: type, stock_code: code,
    stock_name: '股' + code, market: 'sh',
    quantity: qty, price, gross_amount: gross,
    fee: { total: 0 }, net_amount: gross,
    transaction_time: time, note: '', ...extra
  };
}

beforeEach(() => { S.trades = []; idSeq = 0; });

describe('computeHoldings 当日配对池（v3.22.1 跨股票隔离修复）', () => {
  it('做 T：当日买 11.20 / 卖 11.52，当笔盈亏 = +160，不拿隔夜老仓成本比', () => {
    S.trades = [
      tr('buy', '000066', 15.30, 1000, '2026-11-03T10:00:00'),   // 隔夜老仓（高成本）
      tr('buy', '000066', 11.20, 500, '2026-11-04T13:05:00'),
      tr('sell', '000066', 11.52, 500, '2026-11-04T14:46:00'),
    ];
    const h = computeHoldings().find(x => x.code === '000066');
    const sellEv = h.timeline.find(e => e.t.transaction_type === 'sell');
    expect(sellEv.realizedOp).toBeCloseTo(500 * (11.52 - 11.20), 2);   // +160
    // 整轮口径按卖出时点的加权成本（含当日买入）：(15300+5600)/1500 = 13.933
    // → 5760 − 500×13.933 = −1206.67
    expect(sellEv.realized).toBeCloseTo(5760 - 500 * ((15300 + 5600) / 1500), 2);
  });

  it('跨股票隔离：同日买 A 又买 B，卖 A 不得配上 B 的买入成本（-6,633.89 回归用例）', () => {
    S.trades = [
      tr('buy', '000066', 11.20, 500, '2026-11-04T13:05:00'),    // A：5,600
      tr('buy', '600999', 38.30, 500, '2026-11-04T13:40:00'),    // B：19,150（高价新仓）
      tr('sell', '000066', 11.52, 500, '2026-11-04T14:46:00'),   // 卖 A
    ];
    const a = computeHoldings().find(x => x.code === '000066');
    const sellEv = a.timeline.find(e => e.t.transaction_type === 'sell');
    expect(sellEv.realizedOp).toBeCloseTo(500 * (11.52 - 11.20), 2);   // +160
    // 旧 bug 下 avgDay = (5600+19150)/1000 = 24.75 → realizedOp ≈ −6,615
  });

  it('跨日重置：昨日买入池不参与今日卖出配对', () => {
    S.trades = [
      tr('buy', '000066', 20.00, 500, '2026-11-03T10:00:00'),
      tr('sell', '000066', 11.52, 500, '2026-11-04T14:46:00'),   // 隔日卖出，无当日池
    ];
    const h = computeHoldings().find(x => x.code === '000066');
    const sellEv = h.timeline.find(e => e.t.transaction_type === 'sell');
    expect(sellEv.realizedOp).toBeCloseTo(5760 - 500 * 20.00, 2);      // 回落整轮口径
  });

  it('当日买入量不足卖出量：缺口部分回落历史加权成本', () => {
    S.trades = [
      tr('buy', '000066', 20.00, 1000, '2026-11-03T10:00:00'),
      tr('buy', '000066', 11.20, 200, '2026-11-04T13:05:00'),
      tr('sell', '000066', 11.52, 500, '2026-11-04T14:46:00'),
    ];
    const h = computeHoldings().find(x => x.code === '000066');
    const sellEv = h.timeline.find(e => e.t.transaction_type === 'sell');
    // 200 股配当日 11.20 + 300 股配卖出时点加权成本：
    // 加权 = (20000+2240)/1200 = 18.533 → 200×0.32 + 300×(11.52−18.533) = −2040
    expect(sellEv.realizedOp)
      .toBeCloseTo(200 * (11.52 - 11.20) + 300 * (11.52 - (20000 + 2240) / 1200), 2);
  });

  it('持仓与加权成本不受配对池影响（权威口径回归）', () => {
    S.trades = [
      tr('buy', '000066', 11.20, 500, '2026-11-04T13:05:00'),
      tr('sell', '000066', 11.52, 500, '2026-11-04T14:46:00'),
      tr('buy', '600999', 38.30, 500, '2026-11-04T13:40:00'),
    ];
    const list = computeHoldings();
    const a = list.find(x => x.code === '000066');
    const b = list.find(x => x.code === '600999');
    expect(a.qty).toBe(0);
    expect(a.realized).toBeCloseTo(500 * (11.52 - 11.20), 2);          // 清仓全落地
    expect(b.qty).toBe(500);
    expect(b.costValue).toBeCloseTo(38.30 * 500, 2);
  });
});
