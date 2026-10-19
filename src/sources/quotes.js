/* 数据源适配器：东财/腾讯实时快照（从 legacy/app.js NetQuote 逐字移植，返回 Map）
   注意：此处不再自带 NetLog/熔断——观测与治理统一由 DataLayer 承担。 */

/* sym: sh600519 / sz000001 / bj920xxx → secid: 1.x / 0.x */
function toSecids(syms) {
  return syms.map(s => (s.startsWith('sh') ? '1.' : '0.') + s.slice(2)).join(',');
}

export const emQuote = {
  name: 'em-quote',
  gapMs: 0,
  maxFails: 3,
  cooldownMs: 10 * 60 * 1000,
  async run({ syms }, fetchImpl) {
    const fetch2 = fetchImpl || fetch;
    const url = 'https://push2.eastmoney.com/api/qt/ulist.np/get?secids=' + toSecids(syms)
      + '&fields=f2,f3,f12,f14,f15,f16,f17,f18&fltt=2';
    const res = await fetch2(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const out = new Map(); let qt = '';
    const num = v => { const n = parseFloat(v); return (v == null || v === '-' || isNaN(n)) ? null : n; };
    for (const it of ((j.data && j.data.diff) || [])) {
      const price = num(it.f2), code = it.f12 && String(it.f12);
      if (!code || !(price > 0)) continue;
      out.set(code, { price, name: it.f14 || code, pct: num(it.f3),
        prevClose: num(it.f18), open: num(it.f17), high: num(it.f15), low: num(it.f16) });
    }
    if (out.size) qt = new Date().toTimeString().slice(0, 8);
    if (!out.size) throw new Error('东财快照 0/' + syms.length + ' 只（全未返回）');
    return { out, qt, missed: syms.length - out.size };
  },
};

export const txQuote = {
  name: 'tx-quote',
  gapMs: 0,
  maxFails: 3,
  cooldownMs: 10 * 60 * 1000,
  async run({ syms }, fetchImpl) {
    const fetch2 = fetchImpl || fetch;
    const url = 'https://qt.gtimg.cn/q=' + syms.join(',');
    const res = await fetch2(url);
    const buf = await res.arrayBuffer();
    const text = new TextDecoder('gbk').decode(buf);
    const out = new Map(); let qt = '';
    const num = v => { const n = parseFloat(v); return isNaN(n) ? null : n; };
    for (const m of text.matchAll(/v_[a-z]{2}(\d{6})="([^"]*)"/g)) {
      const p = m[2].split('~');
      if (p.length < 40) continue;
      const price = parseFloat(p[3]);
      if (!(price > 0)) continue;
      out.set(m[1], { price, name: p[1], pct: parseFloat(p[32]),
        prevClose: num(p[4]), open: num(p[5]), high: num(p[33]), low: num(p[34]) });
      if (p[30] && p[31]) qt = p[30].replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3') + ' ' + p[31];
    }
    if (!out.size) throw new Error('腾讯快照 0/' + syms.length + ' 只（全未返回）');
    return { out, qt, missed: syms.length - out.size };
  },
};
