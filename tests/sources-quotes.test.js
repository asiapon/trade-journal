/* 源适配器解析单测：东财/腾讯快照（fake fetch，不联网） */
import { describe, it, expect } from 'vitest';
import { emQuote, txQuote } from '../src/sources/quotes.js';

const fakeFetch = (body, ok = true, status = 200) => async () => ({
  ok, status, arrayBuffer: async () => body,
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
});

describe('em-quote 解析', () => {
  it('ulist diff → Map（停牌/无效价跳过）', async () => {
    const body = { data: { diff: [
      { f2: 1500.5, f3: 2.35, f12: '600519', f14: '贵州茅台', f15: 1510, f16: 1490, f17: 1495, f18: 1466 },
      { f2: '-', f3: '-', f12: '000001', f14: '平安银行' },              // 停牌
      { f2: 0, f3: 0, f12: '999999', f14: '无效' },                       // 价 0
    ] } };
    const r = await emQuote.run({ syms: ['sh600519', 'sz000001', 'sz999999'] }, fakeFetch(body));
    expect(r.out.size).toBe(1);
    const it = r.out.get('600519');
    expect(it.price).toBe(1500.5);
    expect(it.name).toBe('贵州茅台');
    expect(it.prevClose).toBe(1466);
    expect(r.missed).toBe(2);
  });
  it('HTTP 非 200 → throw（走 DL 熔断）', async () => {
    await expect(emQuote.run({ syms: ['sh600519'] }, fakeFetch('', false, 503))).rejects.toThrow('HTTP 503');
  });
  it('全部未返回 → throw', async () => {
    await expect(emQuote.run({ syms: ['sh600519'] }, fakeFetch({ data: { diff: [] } }))).rejects.toThrow('0/1');
  });
});

describe('tx-quote 解析', () => {
  it('GBK 文本 → Map + 报价时间', async () => {
    const line = 'v_sh600519="1~Moutai~600519~1500.50~1466.00~1495.00~12345~6789~100~x~x~x~x~x~x~x~x~x~x~x~x~x~x~x~x~x~x~x~x~x~20261019~150001~2.35~1510.00~1490.00~x~x~x~x~x~~~~~";';
    const bytes = new Uint8Array(Array.from(line, c => c.charCodeAt(0)));
    const r = await txQuote.run({ syms: ['sh600519'] }, fakeFetch(bytes.buffer));
    const it = r.out.get('600519');
    expect(it.price).toBe(1500.5);
    expect(it.name).toBe('Moutai');
    expect(it.pct).toBe(2.35);
    expect(it.prevClose).toBe(1466);
    expect(r.qt).toBe('2026-10-19 150001');
  });
});
