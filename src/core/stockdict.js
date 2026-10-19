/* 全市场股票字典（自 legacy 拆出） */
import { inferMarket } from '../shared/utils.js';
import { NetLog } from './netlog.js';

export const StockDict = {
  d: {},          // code -> {name, py, mkt}
  ready: false,
  async init() {
    const SEED_KEY = 'sj_stock_dict_seed', AT_KEY = 'sj_stock_dict_at';
    const TTL = 7 * 24 * 3600 * 1000;
    let seeded = false;
    try {
      const at = Number(localStorage.getItem(AT_KEY) || 0);
      const seed = localStorage.getItem(SEED_KEY);
      if (seed && at && Date.now() - at < TTL) { seeded = this.apply(seed) >= 1000; }
    } catch (e) { /* */ }
    if (!seeded) {
      const t0 = Date.now();
      try {
        const res = await fetch('stock-dict.json?v=' + APP_VER, { cache: 'no-cache' });
        const raw = await res.text();
        if (this.apply(raw) >= 1000) {
          NetLog.push('dict', '股票字典 stock-dict.json', true, Date.now() - t0, '种子载入');
          try { localStorage.setItem(SEED_KEY, raw); localStorage.setItem(AT_KEY, String(Date.now())); } catch (e) { /* 配额满 */ }
        }
      } catch (e) { NetLog.push('dict', '股票字典 stock-dict.json', false, Date.now() - t0, e.message || String(e)); /* 拉取失败：仅用已学到的条目 */ }
    }
    this.ready = true;
    this.learnFromState();
  },
  apply(raw) {
    let j = null;
    try { j = JSON.parse(raw); } catch (e) { return 0; }
    const arr = (j && j.d) || [];
    let n = 0;
    for (const row of arr) {
      const code = String(row[0] || ''), name = String(row[1] || ''), py = String(row[2] || '');
      if (!/^\d{6}$/.test(code) || !name) continue;
      this.d[code] = { name, py, mkt: inferMarket(code) };
      n++;
    }
    return n;
  },
  /* 从既有数据（交易/自选/行情）补充字典条目。
     ⚠️ v3.8.60：**绝不覆盖字典已有条目**。
     历史教训：一笔误录的「603393 红四方」经 learnFromState() 把字典里
     「603393 = 新天然气」改成了「红四方」，而 603393 是真实存在的股票 ——
     污染后输入「红四方」联想给 603393、输入 603393 显示红四方，越用越乱，
     且会在每次启动时自我复现。故只在代码**不在字典中**时才学习（用于补新股）。 */
  learn(code, name) {
    code = String(code || '').trim(); name = String(name || '').trim();
    if (!/^\d{6}$/.test(code) || !name) return;
    if (this.d[code]) return;   // 字典已有该代码：以字典为准，不被用户数据覆盖
    this.d[code] = { name, py: '', mkt: inferMarket(code) };
  },
  learnFromState(S) {
    if (!S) return;   // init() 内部调用时尚无状态对象：跳过
    if (!this.ready) return;
    (S.trades || []).forEach(t => this.learn(t.stock_code, t.stock_name));
    (S.watchlist || []).forEach(w => this.learn(w.stock_code, w.stock_name));
    (S.quotes || []).forEach(q => { if (q && q.stock_code) this.learn(q.stock_code, q.stock_name); });
  },
  /* 匹配优先级：代码前缀 > 拼音首字母前缀 > 名称包含 > 拼音包含 */
  search(txt, limit) {
    txt = String(txt || '').trim().toLowerCase();
    if (!txt) return [];
    const out = [];
    for (const code in this.d) {
      const d = this.d[code];
      const nm = d.name.toLowerCase();
      const py = d.py || '';
      let r = -1;
      if (code.indexOf(txt) === 0) r = 0;
      else if (py && py.indexOf(txt) === 0) r = 1;
      else if (nm.indexOf(txt) >= 0) r = 2;
      else if (py && py.indexOf(txt) >= 0) r = 3;
      if (r < 0) continue;
      out.push({ code, name: d.name, mkt: d.mkt, _r: r });
    }
    out.sort((a, b) => a._r - b._r || (a.code < b.code ? -1 : 1));
    const res = out.slice(0, limit || 8);
    res.forEach(x => delete x._r);
    return res;
  },
  /* 「600519 贵州茅台」/「600519」/「gzmt」/「贵州茅台」统一解析
     ⚠️ v3.8.60：「代码 + 名称」组合与字典冲突时，**以字典为准**并置 `conflict`。
     历史教训：用户误输入「红四方 603393」（603393 实为「新天然气」）时，
     原实现直接返回 {code:603393, name:红四方} 并静默入库 —— 名称与代码张冠李戴，
     且经 learnFromState() 进一步污染整本字典。现在改为：只要字典里这个代码有归属，
     就采信字典的名称，并把用户原本写的名称放进 conflict.typedName 供上层提示。 */
  resolve(txt) {
    txt = String(txt || '').trim();
    const m = txt.match(/^(\d{5,6})(?:[\s·、,，]+(.*))?$/);
    if (m) {
      const code = m[1];
      const known = this.d[code];
      const typedName = (m[2] && m[2].trim()) || '';
      /* 字典有该代码：名称一律以字典为准 */
      if (known) {
        const conflict = typedName && typedName !== known.name
          ? { typedName, dictName: known.name } : null;
        return { code, name: known.name, mkt: known.mkt || inferMarket(code), conflict };
      }
      /* 字典没有该代码：允许手动录入（可能是字典未收录的新股），但名称用用户写的 */
      return { code, name: typedName, mkt: inferMarket(code), unknown: true };
    }
    const hits = this.search(txt, 1);
    return hits.length ? hits[0] : null;
  }
};

/* ---------- 通用联想下拉（自选 / 交易表单共用） ---------- */
/* v3.8.86 加自选弹窗 PC 档隐藏股票联想（CSS 里 `#watchModal #tvWfSug{display:none}`）。
   但只隐藏视觉不够：`input` 事件照旧会触发 showShield() 插入全屏透明防护罩
   （.modal-mask 内 inset:0 / z-index:29），用户点「添加」按钮时第一次点击会被它吞掉。
   所以这里做双保险 —— 候选压根不渲染，也不插罩。 */
