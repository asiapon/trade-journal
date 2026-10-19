/* ============================================================
   v3.18.0 静态数据中心（DataHub）—— 常用行情静态数据的「归拢+定时更新」
   ------------------------------------------------------------
   为什么要有它：此前股票名录（stock-dict.json）与板块成分（board-dict.json）
   都是**随应用打包的静态快照**（v2026-10-09），新上市 / 退市 / 更名 / 板块调整
   都不会更新；日K已有 KLib 每日增量，但没有「收盘后定时」的语义；周K完全没有。
   本模块把四类常用静态数据归拢到 设置 → 数据管理，统一支持手动更新与每日定时。

   四个数据集（DS）：
   1) stocks  股票名录：东财 push2 clist 全A列表（代码/名称）→ 合并进 StockDict
      （已有拼音保留；旧字典有而新列表没有的条目=退市股，保留不删，避免历史
        交易/自选的名字变空）。写回 sj_stock_dict_seed 键（格式与种子一致），
        下次启动 StockDict.init 的 localStorage 快路径直接吃到最新版。
   2) boards  板块成分：行业(496)+概念(508) 板块列表 + 逐板块成分股（~1000 请求，
      并发 4 + 间隔 40ms，实测约 1 分钟）。输出与 board-dict.json 完全同格式，
      写回 sj_board_dict_v1 键 + applyBoardDict() 内存即时生效。
   3) kline   日K线：复用 KLib.ensure（增量同步，含已收盘规则/半根剔除）。
   4) week    周K线：**由日K聚合生成（零网络请求）**——同一数据源口径一致、
      免抓取；未走完的当周按「已收盘规则」剔除（15:00 前当周不含本周五半根）。

   存储：localStorage 优先（StockDict/board 加载逻辑零改动即接管），
      写满（QuotaExceeded）自动落 IndexedDB（sj_kline 库 meta store），启动兜底回读。
      ★ 两处都只是「更新后的数据」，内存里的 StockDict.d / state.boardDict 才是权威。

   定时（autoCheck）：设定时刻（默认 16:30 收盘后）+ 当天已跑跳过 + 周末跳过
      + 页面常驻 10 分钟轮询（打开后跨过设定时刻也能触发）。失败当天不自动重试
      （防打爆接口），手动更新不受限。重入保护：_busy 期间再次触发直接跳过。
   ============================================================ */
'use strict';

const DataHub = {
  /* ---------- 配置 ---------- */
  CONC: 4, GAP: 40,                       // clist 批量请求节流：并发 4 + 40ms（≈60 req/s 以下，东财 clist 实测宽容）
  MIN_STOCKS: 1000, MIN_BOARDS: 100,      // 写入防线：取回数低于阈值视为接口异常，拒写（测试可调低）
  DS_LS: 'sj_dh_last_v1',                 // {stocks:{d:'2026-10-16',ok:true},...} 当天已跑标记
  AUTO_KEY: 'sj_dh_auto',                 // '0'=关；缺省=开
  AUTO_AT_KEY: 'sj_dh_at',                // 'HH:MM'，缺省 '16:30'
  _busy: null,                            // 重入保护：进行中的更新 Promise
  _weekMap: null, _weekVer: '',          // 周K聚合缓存（ver=日K targetDate）

  /* 数据集登记表：设置页状态表 + autoCheck 的执行顺序都由它驱动 */
  DS: [
    { key: 'stocks', label: '股票名录', desc: '全市场 A 股代码/名称（东财 clist，约 12 次请求）' },
    { key: 'boards', label: '板块成分', desc: '行业+概念板块及成分股（约 1000 次请求，1 分钟左右）' },
    { key: 'kline',  label: '日K线',   desc: '全市场日K（复用 K线库 增量同步）' },
    { key: 'week',   label: '周K线',   desc: '由日K按自然周聚合，零网络请求' },
  ],

  /* ---------- 小工具 ---------- */
  todayStr(now) {
    now = now || new Date();
    const p = n => String(n).padStart(2, '0');
    return now.getFullYear() + '-' + p(now.getMonth() + 1) + '-' + p(now.getDate());
  },
  autoOn() {
    try { return localStorage.getItem(this.AUTO_KEY) !== '0'; } catch (e) { return true; }
  },
  autoAt() {
    /* 'HH:MM' 校验+规范：允许 H:MM / H:M 简写（逐段补零），非法值一律回落 16:30（收盘后） */
    let v = '';
    try { v = String(localStorage.getItem(this.AUTO_AT_KEY) || ''); } catch (e) { /* */ }
    const m = /^(\d{1,2}):(\d{1,2})$/.exec(v);
    if (m) {
      const h = +m[1], mi = +m[2];
      if (h < 24 && mi < 60) return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
    }
    return '16:30';
  },
  lastGet() {
    try { return JSON.parse(localStorage.getItem(this.DS_LS) || '{}'); } catch (e) { return {}; }
  },
  lastSet(key, ok, now) {
    const m = this.lastGet();
    m[key] = { d: this.todayStr(now), ok: !!ok, at: Date.now() };
    try { localStorage.setItem(this.DS_LS, JSON.stringify(m)); } catch (e) { /* */ }
  },

  /* ---------- 定时调度 ---------- */
  /* 某数据集今天是否该自动跑：总开关开 && 已过设定时刻 && 今天没跑过 && 工作日 */
  isDue(key, now) {
    now = now || new Date();
    if (!this.autoOn()) return false;
    const wd = now.getDay();
    if (wd === 0 || wd === 6) return false;          // 周末不跑（名录/板块周末没变化，日K周一开盘后补）
    const [h, m] = this.autoAt().split(':').map(Number);
    const nowMin = now.getHours() * 60 + now.getMinutes();
    if (nowMin < h * 60 + m) return false;
    const last = this.lastGet()[key];
    return !(last && last.d === this.todayStr(now)); // 今天已尝试过（无论成败）→ 不再自动重试
  },
  /* boot 挂载 + 页面常驻轮询。原因：云端托管版没有服务端 cron，「定时」只能由
     前端承担 —— 打开时已过时刻立即补跑；页面一直开着则轮询跨过时刻后触发。 */
  startTimer() {
    setTimeout(() => this.autoCheck().catch(() => { /* */ }), 20 * 1000);   // 启动 20s 后先查一次（避开应用初始化峰值）
    setInterval(() => this.autoCheck().catch(() => { /* */ }), 10 * 60 * 1000);
  },
  async autoCheck() {
    if (typeof S !== 'undefined' && S.mode === 'cloud' && !S.token) return { skipped: 'anon' };
    const due = this.DS.filter(x => this.isDue(x.key));
    if (!due.length) return { skipped: 'none' };
    const r = await this.updateAll(null, { quiet: true, only: due.map(x => x.key) });
    return r;
  },

  /* ---------- IndexedDB 兜底（localStorage 配额满时） ---------- */
  /* 复用 KLib 的 sj_kline 库（meta store），不必再开第二个库 */
  async _metaGet(k) {
    if (typeof KLib === 'undefined') return null;
    try { return await KLib._tx(KLib.S_META, 'readonly', st => st.get(k)); } catch (e) { return null; }
  },
  async _metaPut(k, v) {
    if (typeof KLib === 'undefined') return;
    try { await KLib._tx(KLib.S_META, 'readwrite', st => st.put({ k, v })); } catch (e) { /* */ }
  },
  _saveWithFallback(lsKey, idbKey, raw) {
    /* localStorage 优先（启动快路径零开销），配额满落 IndexedDB；都不行内存已生效 */
    try { localStorage.setItem(lsKey, raw); return 'ls'; }
    catch (e) { /* 配额满 */ }
    this._metaPut(idbKey, raw);
    return 'idb';
  },
  /* 启动兜底：localStorage 没有（被清/配额满没写进去）→ 从 IndexedDB 回读并应用。
     板块字典同时改为启动即应用（原实现「分析页用到才懒加载」，设置页摘要会
     显示「板块成分 0 个」误导用户以为没数据）。 */
  async hydrate() {
    let restored = [];
    /* 股票名录：sj_stock_dict_seed 缺失或条目过少时从 idb 回读（apply 合并式，先种子后这里不冲突） */
    try {
      let n = 0; for (const c in (typeof StockDict !== 'undefined' ? StockDict.d : {})) n++;
      if (typeof StockDict !== 'undefined' && n < 2000) {
        const row = await this._metaGet('dh_stocks');
        if (row && row.v && StockDict.apply(row.v) >= 1000) restored.push('stocks');
      }
    } catch (e) { /* */ }
    /* 板块：localStorage 版 → 内存；仍空再从 idb 回读 */
    try {
      if (typeof loadBoardDict === 'function') loadBoardDict();
      if (typeof applyBoardDict === 'function' && (!state.boardDict || !state.boardDict.length)) {
        const row = await this._metaGet('dh_boards');
        if (row && row.v && applyBoardDict(row.v) > 0) restored.push('boards');
      }
    } catch (e) { /* */ }
    return restored;
  },

  /* ---------- 取数：东财 push2 clist ---------- */
  async _clist(fs, fields, onRows, label) {
    /* 分页拉全：pz=500，total 由首页返回；单页失败重试 1 次，仍失败抛错（绝不静默） */
    const pz = 500;
    let pn = 1, total = Infinity, got = 0;
    for (;;) {
      const url = 'https://push2.eastmoney.com/api/qt/clist/get?pn=' + pn + '&pz=' + pz
        + '&po=1&np=1&fltt=2&invt=2&fid=f12&fs=' + encodeURIComponent(fs) + '&fields=' + fields;
      let d = null;
      for (let tryN = 0; tryN < 2 && !d; tryN++) {
        try {
          const r = await fetch(url, { cache: 'no-cache' });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const j = await r.json();
          if (!j || !j.data) throw new Error('返回无 data');
          d = j.data;
        } catch (e) {
          if (tryN === 1) throw new Error(label + ' 第 ' + pn + ' 页失败：' + (e.message || e));
          await new Promise(res => setTimeout(res, 500));
        }
      }
      if (pn === 1) total = d.total || 0;
      const rows = (d.diff || []);
      if (!rows.length) break;                       // 翻过头了（total 虚高 / 数据减少）
      await onRows(rows, total);
      got += rows.length;
      if (got >= total) break;
      pn++;
      await new Promise(res => setTimeout(res, this.GAP));
    }
    return got;
  },
  async _pool(items, worker, onProgress) {
    /* 并发池：与 KLib.ensure 同款 worker 模式。
       v3.18.2 熔断：worker 抛 {__breaker} 时整池立即停（东财被风控时旧写法会把上千个注定
       失败的请求全打完，白白加重封禁）；熔断以 Error 抛给调用方，绝不静默。 */
    let next = 0, done = 0, broken = null;
    const run = async () => {
      for (;;) {
        if (broken) return;
        const i = next++;
        if (i >= items.length) return;
        try { await worker(items[i], i); } catch (e) { if (e && e.__breaker && !broken) broken = e; }
        done++;
        if (onProgress && (done % 20 === 0 || done === items.length)) onProgress(done, items.length);
        await new Promise(r => setTimeout(r, this.GAP));
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.CONC, items.length) }, run));
    if (broken) throw new Error(broken.__breaker);
    return done;
  },

  /* ---------- 数据集 1：股票名录 ---------- */
  async updStocks(prog) {
    const t0 = Date.now();
    const old = (typeof StockDict !== 'undefined' && StockDict.d) || {};
    const list = [];                                 // [{code,name}]
    await this._clist('m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048', 'f12,f14',
      async (rows) => {
        for (const r of rows) {
          const c = String(r.f12 || ''), nm = String(r.f14 || '').trim();
          if (/^\d{6}$/.test(c) && nm) list.push({ code: c, name: nm });
        }
      }, '股票名录');
    if (list.length < this.MIN_STOCKS) throw new Error('股票名录只取回 ' + list.length + ' 条，疑似接口异常，已放弃写入');
    /* 合并策略：新列表覆盖（名称更新）；已有拼音保留；旧字典独有条目（退市股）保留 */
    const next = {}, del = [];
    for (const s of list) {
      const o = old[s.code];
      next[s.code] = { name: s.name, py: (o && o.py) || '', mkt: inferMarket(s.code) };
    }
    for (const c in old) if (!next[c]) { next[c] = old[c]; del.push(c); }
    if (typeof StockDict !== 'undefined') { StockDict.d = next; StockDict.ready = true; }
    /* 写回种子键（与 stock-dict.json 同格式），下次启动 localStorage 快路径直接生效 */
    const arr = [];
    for (const c in next) arr.push([c, next[c].name, next[c].py || '']);
    const raw = JSON.stringify({ v: 'online-' + this.todayStr(), n: arr.length, d: arr });
    const where = this._saveWithFallback('sj_stock_dict_seed', 'dh_stocks', raw);
    try { localStorage.setItem('sj_stock_dict_at', String(Date.now())); } catch (e) { /* */ }
    NetLog.push('dict', '静态数据中心·股票名录', true, Date.now() - t0,
      `最新 ${list.length} 条（沿用旧拼音；退市保留 ${del.length} 条）→ ${where === 'ls' ? 'localStorage' : 'IndexedDB'}`);
    return { n: list.length, kept: del.length, ms: Date.now() - t0 };
  },

  /* ---------- 数据集 2：板块成分 ---------- */
  async updBoards(prog) {
    const t0 = Date.now();
    /* ① 板块列表：行业(t:2) + 概念(t:3) */
    const boards = [];                               // [{bk,name,type}]
    for (const [fs, type] of [['m:90+t:2+f:!50', '行业'], ['m:90+t:3+f:!50', '概念']]) {
      await this._clist(fs, 'f12,f14', async (rows) => {
        for (const r of rows) {
          const bk = String(r.f12 || ''), nm = String(r.f14 || '').trim();
          if (/^BK\d{4,6}$/.test(bk) && nm) boards.push({ bk, name: nm, type });
        }
      }, type + '板块列表');
    }
    if (boards.length < this.MIN_BOARDS) throw new Error('板块列表只取回 ' + boards.length + ' 个，疑似接口异常，已放弃写入');
    /* ② 逐板块拉成分股（fs=b:BKxxxx，pz=1000 一页拿全；最大板块不足 600 只） */
    const byName = {};                               // name -> Set(codes)（行业/概念重名合并）
    let failCnt = 0, failStreak = 0;                 // v3.18.2 failStreak=连续失败（熔断看它，不看累计）
    await this._pool(boards, async (b) => {
      try {
        const url = 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=1000&po=1&np=1'
          + '&fltt=2&invt=2&fid=f12&fs=' + encodeURIComponent('b:' + b.bk) + '&fields=f12';
        const r = await fetch(url, { cache: 'no-cache' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        const diff = (j && j.data && j.data.diff) || [];
        if (!diff.length) return;                    // 空成分：合法（部分新板块/指数板块无成分），跳过不算失败
        let st = byName[b.name];
        if (!st) st = byName[b.name] = new Set();
        for (const d of diff) {
          const c = String(d.f12 || '');
          if (/^\d{6}$/.test(c)) st.add(c);
        }
        failStreak = 0;
      } catch (e) {
        failCnt++; failStreak++;
        /* v3.18.2 风控熔断：连续 10 个板块都失败 → 疑似被风控/断网，中止整轮（旧写法打完全部 ~1000 个请求） */
        if (failStreak >= 10) throw { __breaker: '板块成分连续失败过多（疑似接口风控/断网），本轮中止——请稍后再试' };
      }
    }, (done, total) => { prog && prog(done, total); });
    if (failCnt > boards.length * 0.2) throw new Error('成分股拉取失败率过高（' + failCnt + '/' + boards.length + '），已放弃写入');
    /* ③ 输出与 board-dict.json 同格式：b:[[板块名, [codes...]], ...]；空成分板块丢弃 */
    const out = [];
    for (const [nm, set] of Object.entries(byName)) {
      if (set.size) out.push([nm, Array.from(set)]);
    }
    if (out.length < this.MIN_BOARDS) throw new Error('有效板块只剩 ' + out.length + ' 个，已放弃写入');
    const raw = JSON.stringify({ v: 'online-' + this.todayStr(), n: out.length, b: out });
    const where = this._saveWithFallback('sj_board_dict_v1', 'dh_boards', raw);
    try { localStorage.setItem('sj_board_dict_at_v1', String(Date.now())); } catch (e) { /* */ }
    if (typeof applyBoardDict === 'function') applyBoardDict(raw);   // 内存即时生效（板块热度/画像/问答成分表都吃它）
    NetLog.push('dict', '静态数据中心·板块成分', true, Date.now() - t0,
      `${out.length} 个板块（失败 ${failCnt}）→ ${where === 'ls' ? 'localStorage' : 'IndexedDB'}`);
    return { n: out.length, fail: failCnt, ms: Date.now() - t0 };
  },

  /* ---------- 数据集 3：日K线（复用 KLib） ---------- */
  async updKline(prog) {
    if (typeof KLib === 'undefined') throw new Error('K线库模块未加载');
    /* KLib.ensure 自带：已收盘规则（targetDate 盘中退回上一交易日）、
       盘中半根剔除、云端同步、NetLog。这里只是定时触发器。 */
    return KLib.ensure(p => {
      prog && prog(p.total ? p.done : 0, p.total || 0, p.stage || '');
    }, { quiet: true });
  },

  /* ---------- 数据集 4：周K线（由日K聚合，纯函数） ---------- */
  /* dstr 'YYYY-MM-DD' → 该周周一的 'YYYY-MM-DD'（ISO 周，周一为一周起点） */
  weekKey(dstr) {
    const dt = new Date(dstr + 'T00:00:00');
    const shift = (dt.getDay() + 6) % 7;             // Mon=0…Sun=6
    dt.setDate(dt.getDate() - shift);
    const p = n => String(n).padStart(2, '0');
    return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate());
  },
  /* 紧凑日K [d,o,c,h,l,v,a] → 周K [d,o,c,h,l,v,a]（d=该周最后交易日）。
     输入须先过 KLib.stripPartial（盘中当周半根剔除），本函数不重复处理：
     若末根是今天盘中半根，其所在周的聚合会把半根当完整一天 —— 所以调用方
     必须传已 strip 的 bars（updWeek 内部保证）。 */
  weekBarsOne(bars) {
    if (!bars || !bars.length) return [];
    const order = [], byWk = {};
    for (const b of bars) {
      const wk = this.weekKey(b[0]);
      let g = byWk[wk];
      if (!g) { g = byWk[wk] = { d: b[0], o: b[1], c: b[2], h: b[3], l: b[4], v: 0, a: 0 }; order.push(wk); }
      if (b[0] > g.d) g.d = b[0];
      if (b[3] > g.h) g.h = b[3];
      if (b[4] < g.l) g.l = b[4];
      g.c = b[2];
      g.v += b[5] || 0;
      g.a += b[6] || 0;
    }
    return order.map(wk => {
      const g = byWk[wk];
      return [g.d, g.o, g.c, g.h, g.l, g.v, g.a];
    });
  },
  /* 全市场周K：Map(code -> {name, bars})。targetDate 一致时直接用内存缓存。 */
  async weekAll() {
    if (typeof KLib === 'undefined') throw new Error('K线库模块未加载');
    const meta = await KLib.metaGet();
    if (this._weekMap && this._weekVer === meta.targetDate) return { map: this._weekMap, ver: this._weekVer };
    const day = await KLib.all();
    const map = new Map();
    for (const [code, rec] of day) {
      map.set(code, { name: rec.name, bars: this.weekBarsOne(rec.bars || []) });
    }
    this._weekMap = map; this._weekVer = meta.targetDate || '';
    return { map, ver: this._weekVer };
  },
  async updWeek(prog) {
    const t0 = Date.now();
    const { map, ver } = await this.weekAll();       // weekAll 内部先确保日K库已读
    let n = 0;
    for (const [, rec] of map) if (rec.bars.length) n++;
    NetLog.push('kline', '静态数据中心·周K聚合', n > 0, Date.now() - t0, `${n} 只 · 到 ${ver}（由日K聚合，无请求）`);
    return { n, ver, ms: Date.now() - t0 };
  },

  /* ---------- 总入口 ---------- */
  /* opts.only 限定数据集；opts.quiet 静默；onProgress({key,done,total,stage}) */
  async updateAll(onProgress, opts) {
    opts = opts || {};
    if (this._busy) return this._busy;
    this._busy = (async () => {
      const keys = opts.only || this.DS.map(x => x.key);
      const out = {};
      for (const key of keys) {
        const prog = (done, total, stage) => { try { onProgress && onProgress({ key, done, total, stage }); } catch (e) { /* */ } };
        try {
          /* 周K依赖日K：日K本轮在跑/刚跑完则直接聚合，否则先 ensure 日K在库 */
          if (key === 'week' && !keys.includes('kline') && !(typeof KLib !== 'undefined' && KLib._map && KLib._map.size)) {
            await this.updKline();
          }
          out[key] = { ok: true, r: await this['upd' + key[0].toUpperCase() + key.slice(1)](prog) };
          this.lastSet(key, true);
        } catch (e) {
          out[key] = { ok: false, err: e.message || String(e) };
          this.lastSet(key, false);
          NetLog.push('dict', '静态数据中心·' + key, false, 0, e.message || String(e));
        }
      }
      return out;
    })();
    try { return await this._busy; } finally { this._busy = null; }
  },
};
