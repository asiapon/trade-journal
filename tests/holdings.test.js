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

/* ============================================================
   v3.23.0 持仓基线层 computePositions
   ============================================================ */
import { computePositions } from '../src/core/holdings.js';

describe('computePositions 持仓基线层（v3.23.0）', () => {
  beforeEach(() => { S.settings = {}; });

  it('无基线时与纯流水 computeHoldings 完全一致', () => {
    S.trades = [tr('buy', '600001', 10.00, 1000, '2026-11-01T10:00:00')];
    const a = computeHoldings().find(x => x.code === '600001');
    const b = computePositions().find(x => x.code === '600001');
    expect(b.qty).toBe(a.qty);
    expect(b.costValue).toBeCloseTo(a.costValue, 6);
  });

  it('基线种子：数量+成本价（8 位小数精度完整保留）', () => {
    S.settings = { pos_base: [{ stock_code: '600001', stock_name: '测试甲', market: 'sh', qty: 1000, costPrice: 5.71012345, base_date: '2026-11-10' }] };
    const h = computePositions().find(x => x.code === '600001');
    expect(h.qty).toBe(1000);
    expect(h.costValue / h.qty).toBeCloseTo(5.71012345, 10);   // 不做 2 位截断
    expect(h.isBase).toBe(true);
  });

  it('基线日期当天及更早的流水被忽略，之后的流水自动叠加', () => {
    S.settings = { pos_base: [{ stock_code: '600001', stock_name: '测试甲', market: 'sh', qty: 1000, costPrice: 5.71012345, base_date: '2026-11-10' }] };
    S.trades = [
      tr('buy', '600001', 99.00, 5000, '2026-11-09T10:00:00'),  // 基线前的历史流水：不参与
      tr('buy', '600001', 6.00, 500, '2026-11-11T10:00:00'),    // 基线后：加权叠加
    ];
    const h = computePositions().find(x => x.code === '600001');
    expect(h.qty).toBe(1500);
    expect(h.costValue).toBeCloseTo(1000 * 5.71012345 + 500 * 6.00, 6);
    // 卖出与当日买入同天 → 先走当日买入池配对：300×(6.50−6.00) = +150
    S.trades.push(tr('sell', '600001', 6.50, 300, '2026-11-11T14:00:00'));
    const h2 = computePositions().find(x => x.code === '600001');
    const sellEv = h2.timeline.filter(e => e.realizedOp != null).pop();
    expect(sellEv.realizedOp).toBeCloseTo(300 * (6.50 - 6.00), 6);
  });

  it('基线后全部卖出：qty 归零、盈亏落地；纯流水 computeHoldings 不受基线影响', () => {
    S.settings = { pos_base: [{ stock_code: '600001', stock_name: '测试甲', market: 'sh', qty: 2000, costPrice: 5.10, base_date: '2026-11-10' }] };
    S.trades = [
      tr('buy', '600001', 5.00, 2000, '2026-11-01T10:00:00'),   // 基线前流水
      tr('sell', '600001', 5.20, 2000, '2026-11-11T14:00:00'),  // 基线后清仓
    ];
    const p = computePositions().find(x => x.code === '600001');
    expect(p.qty).toBe(0);
    expect(p.realized).toBeCloseTo(2000 * (5.20 - 5.10), 6);    // vs 基线成本
    const f = computeHoldings().find(x => x.code === '600001'); // 纯流水口径不变
    expect(f.qty).toBe(0);
    expect(f.realized).toBeCloseTo(2000 * (5.20 - 5.00), 6);
  });

  it('只有基线、零流水的股票也出现在持仓里（名称/市场来自基线）', () => {
    S.settings = { pos_base: [{ stock_code: '688111', stock_name: '新股', market: 'sh', qty: 200, costPrice: 88.88, base_date: '2026-11-11' }] };
    S.trades = [];
    const h = computePositions().find(x => x.code === '688111');
    expect(h).toBeTruthy();
    expect(h.name).toBe('新股');
    expect(h.qty).toBe(200);
  });
});
