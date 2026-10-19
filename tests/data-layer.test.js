/* DataLayer 内核单测（vitest）：single-flight / L0 TTL / 降级链 / 熔断 / 源级间隔 / 健康 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DL } from '../src/core/data-layer.js';

function fakeAdapter(name, impl, extra) {
  return Object.assign({ name, run: impl, gapMs: 0 }, extra || {});
}

describe('DataLayer', () => {
  beforeEach(() => DL._reset());

  it('L0 TTL：TTL 内第二次取数不发请求', async () => {
    let calls = 0;
    DL.register('q', { ttl: () => 60000, providers: [fakeAdapter('a', async () => { calls++; return { v: calls }; })] });
    const r1 = await DL.get('q', { x: 1 });
    const r2 = await DL.get('q', { x: 1 });
    expect(r1.from).toBe('a');
    expect(r2.from).toBe('L0');
    expect(calls).toBe(1);
  });

  it('force 绕过 L0；不同参数不共享缓存', async () => {
    let calls = 0;
    DL.register('q', { ttl: () => 60000, providers: [fakeAdapter('a', async () => { calls++; return { v: calls }; })] });
    await DL.get('q', { x: 1 });
    await DL.get('q', { x: 1 }, { force: true });
    await DL.get('q', { x: 2 });
    expect(calls).toBe(3);
  });

  it('single-flight：并发同 key 合并为一次请求', async () => {
    let calls = 0;
    DL.register('q', { ttl: () => 0, providers: [fakeAdapter('a', async () => {
      calls++;
      await new Promise(r => setTimeout(r, 30));
      return { v: calls };
    })] });
    const rs = await Promise.all([DL.get('q', {}), DL.get('q', {}), DL.get('q', {})]);
    expect(calls).toBe(1);
    expect(rs[0].from).toBe('a');
    expect(rs[1].from).toBe('inflight');
    expect(rs[2].from).toBe('inflight');
  });

  it('降级链：主源失败自动走备源', async () => {
    DL.register('q', { ttl: () => 0, providers: [
      fakeAdapter('bad', async () => { throw new Error('主源挂了'); }),
      fakeAdapter('good', async () => ({ v: '备源数据' })),
    ] });
    const r = await DL.get('q', {});
    expect(r.from).toBe('good');
    expect(r.value.v).toBe('备源数据');
    const h = DL.health();
    expect(h.find(x => x.src === 'bad').fail).toBe(1);
  });

  it('熔断：连续失败达阈值后跳过该源，冷却后恢复', async () => {
    let badCalls = 0;
    DL.register('q', { ttl: () => 0, providers: [
      fakeAdapter('bad', async () => { badCalls++; throw new Error('x'); }, { maxFails: 3, cooldownMs: 50 }),
      fakeAdapter('good', async () => ({ v: 1 })),
    ] });
    for (let i = 0; i < 3; i++) await DL.get('q', {});
    expect(badCalls).toBe(3);
    await DL.get('q', {});
    await DL.get('q', {});
    expect(badCalls).toBe(3);                    // 熔断中：不再打主源
    const h = DL.health().find(x => x.src === 'bad');
    expect(h.breakerOpen).toBe(true);
    await new Promise(r => setTimeout(r, 60));   // 冷却结束（半开）
    await DL.get('q', {});
    expect(badCalls).toBe(4);
  });

  it('源级最小间隔：同源两次请求间隔 ≥ gapMs', async () => {
    DL.register('q', { ttl: () => 0, providers: [fakeAdapter('slow', async () => ({ v: 1 }), { gapMs: 60 })] });
    const t0 = Date.now();
    await DL.get('q', { a: 1 });
    await DL.get('q', { a: 2 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(55);
  });

  it('全部源失败 → throw 且错误带降级轨迹（绝不静默）', async () => {
    DL.register('q', { ttl: () => 0, providers: [
      fakeAdapter('a', async () => { throw new Error('A挂'); }),
      fakeAdapter('b', async () => { throw new Error('B挂'); }),
    ] });
    await expect(DL.get('q', {})).rejects.toThrow(/\[q\] a:A挂 \| b:B挂/);
  });

  it('未注册 kind → 明确报错', async () => {
    await expect(DL.get('nope', {})).rejects.toThrow('未注册');
  });
});
