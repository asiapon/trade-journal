/* DataLayer 统一数据采集层内核（M1）
   职责：kind 注册表 · L0 内存 TTL · single-flight 在途合并 · 源级串行间隔（令牌）·
        源级熔断（连续失败 N 次 → 冷却）· 降级链 · 健康统计 · NetLog 挂钩。
   原则：get 永远 resolve 或 throw（绝不静默）；消费方只声明 kind，不感知源。 */

export const DL = {
  kinds: new Map(),       // kind -> {providers:[adapter], ttl:fn->ms, slo}
  inflight: new Map(),    // ck -> Promise
  l0: new Map(),          // ck -> {at, value}
  breakers: new Map(),    // src -> {fails, openUntil}
  queues: new Map(),      // src -> Promise（源级串行 + 最小间隔）
  stats: new Map(),       // src -> {ok, fail, ms, lastErr}
  fetchImpl: (...a) => fetch(...a),   // 测试注入
  log: null,              // (ok, src, ms, detail) => void；接入 NetLog 时设置
  now: () => Date.now(),  // 测试注入

  /* ---------- 注册 ---------- */
  register(kind, def) {
    if (!def || !Array.isArray(def.providers) || !def.providers.length) throw new Error('register: providers 必填');
    this.kinds.set(kind, {
      ttl: def.ttl || (() => 0),
      slo: def.slo || '',
      providers: def.providers,
    });
    for (const p of def.providers) {
      if (!this.breakers.has(p.name)) this.breakers.set(p.name, { fails: 0, openUntil: 0 });
      if (!this.stats.has(p.name)) this.stats.set(p.name, { ok: 0, fail: 0, ms: 0, lastErr: '' });
    }
  },

  /* ---------- 取数 ---------- */
  async get(kind, params, opts) {
    const def = this.kinds.get(kind);
    if (!def) throw new Error('DL: 未注册的数据类型 ' + kind);
    const ck = kind + '|' + stableKey(params || {});
    const force = opts && opts.force;

    /* L0 命中 */
    if (!force) {
      const c = this.l0.get(ck);
      if (c && this.now() - c.at < def.ttl()) return { value: c.value, from: 'L0', ms: 0 };
    }
    /* single-flight：同 key 在途合并 */
    if (this.inflight.has(ck)) return { value: await this.inflight.get(ck), from: 'inflight', ms: 0 };

    const p = this.runChain(def, params, kind);
    const pf = p.then(x => x.value);
    pf.catch(() => {});   // 防孤儿拒绝：调用方通过 await p 取错，派生链需显式标记已处理
    this.inflight.set(ck, pf);
    try {
      const { value, from, ms } = await p;
      this.l0.set(ck, { at: this.now(), value });
      return { value, from, ms };
    } finally {
      this.inflight.delete(ck);
    }
  },

  async runChain(def, params, kind) {
    const t0 = this.now();
    const errs = [];
    for (const prov of def.providers) {
      const br = this.breakers.get(prov.name);
      if (this.now() < br.openUntil) { errs.push(prov.name + ':熔断中'); continue; }
      try {
        const value = await this.gate(prov, params);
        br.fails = 0;
        const st = this.stats.get(prov.name);
        st.ok++; st.ms += this.now() - t0;
        if (this.log) this.log(true, prov.name, this.now() - t0, kind);
        return { value, from: prov.name, ms: this.now() - t0 };
      } catch (e) {
        br.fails++;
        const st = this.stats.get(prov.name);
        st.fail++; st.lastErr = String(e && e.message || e);
        if (this.log) this.log(false, prov.name, this.now() - t0, kind + ' ' + st.lastErr);
        errs.push(prov.name + ':' + st.lastErr);
        /* 熔断：连续 N 次失败 → 冷却（N/冷却阈值可由适配器带，默认 3 次 / 10 分钟） */
        const maxFails = prov.maxFails || 3;
        if (br.fails >= maxFails) {
          br.openUntil = this.now() + (prov.cooldownMs || 10 * 60 * 1000);
          br.fails = 0;
        }
      }
    }
    const e = new Error('DL: 所有数据源失败 [' + kind + '] ' + errs.join(' | '));
    e.sources = errs;
    throw e;
  },

  /* 源级串行 + 最小间隔（并发排队，防打爆） */
  gate(prov, params) {
    const gap = prov.gapMs || 0;
    const prev = this.queues.get(prov.name) || Promise.resolve();
    const job = prev.then(() => new Promise((res, rej) => {
      const wait = Math.max(0, gap - (this.now() - (this.queues.get(prov.name + ':t') || 0)));
      setTimeout(async () => {
        this.queues.set(prov.name + ':t', this.now());
        try { res(await prov.run(params, this.fetchImpl)); } catch (e) { rej(e); }
      }, wait);
    }));
    /* 队列只保留末尾等待者，避免长链堆积（失败不影响队列推进） */
    this.queues.set(prov.name, job.catch(() => {}));
    return job;
  },

  /* ---------- 健康（设置页面板用） ---------- */
  health() {
    const out = [];
    for (const [src, st] of this.stats) {
      const total = st.ok + st.fail;
      const br = this.breakers.get(src);
      out.push({ src, ok: st.ok, fail: st.fail, rate: total ? Math.round(st.ok / total * 100) : null,
        avgMs: st.ok ? Math.round(st.ms / st.ok) : null, lastErr: st.lastErr,
        breakerOpen: this.now() < br.openUntil, cooldownLeft: Math.max(0, br.openUntil - this.now()) });
    }
    return out;
  },
  /* 测试辅助 */
  _reset() { this.kinds.clear(); this.inflight.clear(); this.l0.clear(); this.breakers.clear(); this.queues.clear(); this.stats.clear(); },
};

function stableKey(o) {
  return JSON.stringify(Object.keys(o).sort().map(k => [k, o[k]]));
}
