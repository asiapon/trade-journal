/* 行情轮询引擎（NetQuote，含 DataLayer 收口）+ 模型管理器（v0.11.0 自单体拆出） */
import { $, toast, fmt2, fmtP, fmtPct, pnlCls, esc, fmtTime, nowLocalInput, inferMarket, MKT_NAME } from '../shared/utils.js';
import { NetLog, sjTokenHeaders } from '../core/netlog.js';
import { StockDict } from '../core/stockdict.js';
import { DL } from '../core/data-layer.js';
import { emQuote, txQuote } from '../sources/quotes.js';
import { TABLES, BACKEND_URL, RPC_BASE, ACCESS_KEY, CLOUD_HOST, rpc, cloudStore, localStore, setStore, loadAll, saveSetting, sessionHooks, storageHooks } from '../storage/gateway.js';
import { S } from '../core/app-state.js';
import { cloudLlm, renderAll } from '../app.js';
import { switchSetPane } from './me.js';
import { switchView } from '../ui/bind.js';

export const NetQuote = {
  map: new Map(),
  fetchedAt: 0,
  quoteTime: '',
  pending: null,
  ttl: 15 * 1000,            // v3.8.23 缓存 60s → 15s
  eastFailStreak: 0,
  eastDeadUntil: 0,          // 东财连续失败 3 次熔断 10 分钟（期间直接走腾讯）
  idx: new Map(),            // v3.8.26 指数快照：sym(sh000001) -> { name, price, pct }
  idxTime: 0,
  /* v3.8.62 大盘指数清单：前 3 项是原有的三大市场指数，后 3 项是大中小盘宽基，
     凑成「沪 / 深 / 创业板 + 大盘 / 中盘 / 小盘」的市场结构全景。
     本数组是纯配置——请求侧靠 secid 拼批量 URL、渲染侧逐项生成胶囊，都是
     数组驱动，以后增删指数只改这里，不必动任何逻辑。
     secid 规则：沪市与中证系 1.xxxxxx，深市 0.xxxxxx，北交所 0.899xxx。 */
  INDEXES: [
    { sym: 'sh000001', name: '上证指数', secid: '1.000001' },
    { sym: 'sz399001', name: '深证成指', secid: '0.399001' },
    { sym: 'sz399006', name: '创业板指', secid: '0.399006' },
    { sym: 'sh000300', name: '沪深300',  secid: '1.000300' },
    { sym: 'sh000905', name: '中证500',  secid: '1.000905' },
    { sym: 'sh000852', name: '中证1000', secid: '1.000852' },
  ],
  prefix(market, code) {
    if (market === 'bj' || market === 'bse') return 'bj' + code;
    if (market === 'sz') return 'sz' + code;
    if (market === 'sh') return 'sh' + code;
    return (/^(6|5|9)/.test(code) ? 'sh' : 'sz') + code;
  },
  allCodes() {
    const mk = {}, codes = [];
    const add = (c, m) => { if (c && !mk[c]) { mk[c] = m; codes.push(c); } };
    S.trades.forEach(t => add(t.stock_code, t.market));
    S.watchlist.forEach(w => add(w.stock_code, w.market));
    return { codes, mk };
  },
  /* 东财实时快照（主源）：push2 ulist 批量，JSON 无需转码
     secid: 沪 1.xxxx / 深·北 0.xxxx；f2现价 f3涨跌% f12代码 f14名称
     f15最高 f16最低 f17今开 f18昨收；fltt=2 直接返回小数 */
  async fetchEast(syms) {
    /* v0.3.0 M3：取数收口 DataLayer（解析在 sources/quotes.js，治理在 DL） */
    try {
      const r = await DL.get('quote:em', { syms }, { force: true });
      return { out: r.value.out, qt: r.value.qt };
    } catch (e) {
      return null;
    }
  },
  /* 腾讯行情（备选）：v_sz000001="..."，~ 分隔 */
  async fetchTx(syms) {
    /* v0.3.0 M3：取数收口 DataLayer */
    try {
      const r = await DL.get('quote:tx', { syms }, { force: true });
      return { out: r.value.out, qt: r.value.qt };
    } catch (e) {
      return null;
    }
  },
  /* v3.8.26 指数快照：东财 ulist 主源（f12代码+f13市场避免与个股代码撞号）→ 腾讯备选
     v3.8.62 两处调整：① sym 改为按 secid 精确映射，不再用 f13 猜前缀——原写法
     `(it.f13 === 1 ? 'sh' : 'sz')` 会把北交所指数（如北证50，f13=0 且返回 899050）
     误判成 sz899050；② 主源缺项时用腾讯补齐，见下方调用处。 */
  async fetchIdx() {
    const t0 = Date.now();
    /* secid -> sym 反查表：东财返回的 f13 + f12 拼回 secid 后精确取回清单里声明的 sym，
       这样 sh / sz / bj 三种前缀都由清单本身说了算，不依赖任何猜测规则 */
    const symBySecid = new Map(this.INDEXES.map(i => [i.secid, i.sym]));
    const tryEast = async () => {
      const secids = this.INDEXES.map(i => i.secid).join(',');
      /* v3.8.69 补 f4（涨跌额）：手机端「每行一枚胶囊」有大量余量，用户要求把涨跌
         的具体数值也显示出来（原来只有百分比）。f4 = 涨跌额，实测与腾讯 p[31] 一致 */
      const url = 'https://push2.eastmoney.com/api/qt/ulist.np/get?secids=' + secids
        + '&fields=f2,f3,f4,f12,f13,f14&fltt=2';
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      const out = new Map();
      for (const it of ((j.data && j.data.diff) || [])) {
        const price = parseFloat(it.f2), code = it.f12 && String(it.f12);
        if (!code || !(price > 0)) continue;
        const sym = symBySecid.get(it.f13 + '.' + code)      // 精确匹配（含 bj 前缀）
          || ((it.f13 === 1 ? 'sh' : 'sz') + code);          // 兜底：清单之外的意外返回
        out.set(sym, { name: it.f14 || code, price, pct: parseFloat(it.f3), chg: parseFloat(it.f4) });
      }
      return out;
    };
    const tryTx = async () => {
      const res = await fetch('https://qt.gtimg.cn/q=' + this.INDEXES.map(i => i.sym).join(','));
      const buf = await res.arrayBuffer();
      const text = new TextDecoder('gbk').decode(buf);
      const out = new Map();
      /* v3.8.62 正则补 bj：北交所指数的腾讯代码是 bj899050 这种形式，原 (sh|sz) 会整条漏掉 */
      for (const m of text.matchAll(/v_(sh|sz|bj)(\d{6})="([^"]*)"/g)) {
        const p = m[3].split('~');
        const price = parseFloat(p[3]);
        /* v3.8.69 p[31] = 涨跌额（已带符号），与东财 f4 同口径 */
        if (price > 0) out.set(m[1] + m[2], { name: p[1], price, pct: parseFloat(p[32]), chg: parseFloat(p[31]) });
      }
      return out;
    };
    let out = null;
    if (Date.now() >= this.eastDeadUntil) {
      /* v3.9.13 审计：东财指数快照带 URL */
      const idxUrl = 'https://push2.eastmoney.com/api/qt/ulist.np/get?secids=' + this.INDEXES.map(i => i.secid).join(',') + '&fields=f2,f3,f4,f12,f13,f14&fltt=2';
      try { out = await tryEast(); NetLog.push('quote', '东财 指数快照', out.size > 0, Date.now() - t0, `${out.size}/${this.INDEXES.length} 个`, { url: idxUrl, resp: `${out.size}/${this.INDEXES.length} 个` }); }
      catch (e) { NetLog.push('quote', '东财 指数快照', false, Date.now() - t0, e.message || String(e), { url: idxUrl, err: e.message || String(e) }); }
    }
    /* v3.8.62 从「主源全失败才切备源」改成「只要不满员就补齐」：
       原判据 `!out.size` 在指数只有 3 个时够用，扩到 6 个后就不牢靠了——
       东财返回 5/6 也算「非空成功」，缺的那一枚会永远不显示，且不报错、不留痕。
       现在只要有缺项就拉腾讯补缺；已拿到的项不覆盖（腾讯仅补空位，不夺主源口径）。 */
    if (!out || out.size < this.INDEXES.length) {
      const t1 = Date.now();
      try {
        const tx = await tryTx();
        if (tx && tx.size) {
          if (!out) out = new Map();                 // 主源全失败：整体采用腾讯
          let filled = 0;
          for (const [k, v] of tx) if (!out.has(k)) { out.set(k, v); filled++; }
          NetLog.push('quote', '腾讯 指数快照', true, Date.now() - t1,
            filled ? `补齐 ${filled} 个（腾讯共返回 ${tx.size} 个）` : '主源已完整，无需补齐',
            { url: 'https://qt.gtimg.cn/q=' + this.INDEXES.map(i => i.sym).join(','), resp: `腾讯返回 ${tx.size} 个，补齐 ${filled} 个` });
        } else {
          NetLog.push('quote', '腾讯 指数快照', false, Date.now() - t1, `0/${this.INDEXES.length} 个（未获取到）`,
            { url: 'https://qt.gtimg.cn/q=' + this.INDEXES.map(i => i.sym).join(','), err: '未获取到' });
        }
      } catch (e) { NetLog.push('quote', '腾讯 指数快照', false, Date.now() - t1, e.message || String(e), { err: e.message || String(e) }); }
    }
    if (out && out.size) { this.idx = out; this.idxTime = Date.now(); }
  },
  async refresh(force = false) {
    const { codes, mk } = this.allCodes();
    if (this.pending) return this.pending;
    /* v3.8.49 指数与个股解耦判定：
       以前 `if (!codes.length) return` 会直接退出，指数只在「有自选/持仓」时顺带拉一次，
       于是新账号（空账户）登录后大盘指数一条都不显示。现在两条链路各自判新鲜度。 */
    const qFresh = codes.length > 0 && Date.now() - this.fetchedAt < this.ttl
      && codes.every(c => this.map.has(c));
    const iFresh = this.idx.size > 0 && Date.now() - this.idxTime < this.ttl;
    if (!force && qFresh && iFresh) return this.map;
    this.pending = (async () => {
      const merged = new Map(); let qt = ''; let used = [];
      for (let i = 0; i < codes.length; i += 50) {
        const batch = codes.slice(i, i + 50);
        const syms = batch.map(c => this.prefix(mk[c], c));
        let got = null;
        /* 主源东财（连续失败熔断期跳过，直接走腾讯） */
        if (Date.now() >= this.eastDeadUntil) {
          got = await this.fetchEast(syms);
          if (got) { this.eastFailStreak = 0; used.push('east'); }
          else {
            this.eastFailStreak++;
            if (this.eastFailStreak >= 3) {
              this.eastDeadUntil = Date.now() + 10 * 60 * 1000;
              NetLog.push('quote', '东财熔断→切腾讯', true, 0, `连续失败 ${this.eastFailStreak} 次，10 分钟后重试东财`);
            }
          }
        }
        /* 备选腾讯 */
        if (!got) {
          got = await this.fetchTx(syms);
          if (got) used.push('tx');
        }
        if (got) {
          for (const [k, v] of got.out) merged.set(k, v);
          if (got.qt) qt = got.qt;
        }
      }
      if (merged.size) {
        this.map = merged;
        this.fetchedAt = Date.now();
        if (qt) this.quoteTime = qt;
      }
      if (force || !iFresh) await this.fetchIdx();   // v3.8.26 指数随行情一并刷新 / v3.8.49 空账户也拉
      this.pending = null;
      return merged;
    })();
    return this.pending;
  },
  get(code) { return this.map.get(code) || null; }
};
/* 拉一次行情并刷新相关页面（登录后 / 手动刷新时调用） */
export async function refreshQuotes(force = false) {
  /* v3.9.13 审计：这一轮行情请求标上触发来源（含后台切回前台自动强刷） */
  return NetLog.withCtx('总览/行情·刷新' + (force ? '(强刷)' : ''), async () => {
    await NetQuote.refresh(force);
    renderAll();
  });
}
/* v3.8.23 页面从后台切回前台时自动强刷行情（数据不实时补偿） */
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && typeof S !== 'undefined' && S.token) refreshQuotes(true).catch(() => { /* */ });
});

/* ============================================================
   存储适配层
   ============================================================ */
export const ModelMgr = {
  platform: [],   // 云端模型目录
  custom: [],     // 自定义模型 {key,name,baseUrl,model,apiKey}
  cur: null,      // 当前模型
  loaded: false,
  loadCache() { try { this.platform = JSON.parse(localStorage.getItem('sj_model_list') || '[]'); } catch (e) { /* */ } },
  loadCustom() { try { this.custom = JSON.parse(localStorage.getItem('sj_custom_models') || '[]'); } catch (e) { this.custom = []; } },
  saveCustom() {
    localStorage.setItem('sj_custom_models', JSON.stringify(this.custom));
    /* 同步到云端：其他客户端也能解析「自定义模型」选择（含 apiKey，存于用户自己的 settings） */
    if (S.mode === 'cloud') saveSetting('model_custom', JSON.stringify(this.custom)).catch(() => {});
  },
  async reload() {
    if (!cloudLlm) throw new Error('云端模型服务不可用（本地模式）');
    const llm = cloudLlm.llm || cloudLlm;   // SDK 命名空间：cloud.llm.models / cloud.llm.chat
    const listed = (await llm.models.list()) || [];
    this.platform = listed.filter(m => m.disabled !== true);
    this.platform = listed.filter(m => m.disabled !== true);
    this.loaded = true;
    localStorage.setItem('sj_model_list', JSON.stringify(this.platform));
    this.loadCur(); this.render();
    return this.platform;
  },
  all() {
    return [...this.platform.map(m => Object.assign({ platform: true }, m)),
            ...this.custom.map(c => Object.assign({ custom: true }, c))];
  },
  modelId(m) { return m.custom ? 'c:' + m.key : 'p:' + m.id; },
  label(m) {
    if (!m) return '（未选择模型）';
    if (m.custom) return `${m.name}·${m.model}（自定义）`;
    const c = this.creditsText(m);
    return (m.name || m.id) + (m.vendor ? ' · ' + m.vendor : '') + (c ? '（费率 ' + c + '）' : '');
  },
  /* 积分费率："x0.08 credits" / "x0.05" → "0.08x" 风格展示；0 = 免费 */
  creditsText(m) {
    if (!m || m.custom || !m.credits) return '';
    const s = String(m.credits).replace(/\s*credits?$/i, '').replace(/^x/i, '').trim();
    if (!s || isNaN(parseFloat(s))) return '';
    return (parseFloat(s) === 0 ? '免费' : s + 'x');
  },
  /* 当前模型以「ID 字符串」持久化（与 trade-manager 一致），目录未加载时绝不降级覆盖，
     避免刷新后因目录缓存为空/过期把用户选择冲掉。 */
  loadCur() {
    let saved = localStorage.getItem('sj_model_cur') || '';
    if (saved.startsWith('{')) {
      // 旧版存的是完整对象 → 迁移为 ID
      try { const o = JSON.parse(saved); saved = o.custom ? 'c:' + o.key : (o.id ? 'p:' + o.id : ''); } catch (e) { saved = ''; }
      if (saved) localStorage.setItem('sj_model_cur', saved);
    }
    this.savedId = saved || null;
    const all = this.all();
    const found = saved ? all.find(m => this.modelId(m) === saved) : null;
    if (found) {
      this.cur = found;
    } else if (saved && !this.loaded) {
      this.cur = null;          // 目录还没就绪：保留 savedId，等 reload 后再解析
    } else {
      /* v3.15.2 没有保存选择时：优先选第一个「自定义模型」（用户自己的 Key），否则第一个可用 */
      this.cur = this.custom[0] || all[0] || null;
      if (this.cur) { this.savedId = this.modelId(this.cur); localStorage.setItem('sj_model_cur', this.savedId); }
    }
  },
  setCur(idStr) {
    const m = this.all().find(x => this.modelId(x) === idStr) || null;
    if (m) {
      this.cur = m; this.savedId = idStr;
      localStorage.setItem('sj_model_cur', idStr);
      this.persistCloud();
    }
    this.render();
  },
  /* 云端 settings 为权威（同 trade-manager 的 app_config 机制），写失败不阻塞 UI */
  async persistCloud() {
    if (S.mode !== 'cloud' || !this.cur) return;
    try { await saveSetting('model_config', JSON.stringify({ cur: this.modelId(this.cur) })); } catch (e) { /* */ }
  },
  /* 登录后调用：云端有配置时以云端为准（跨设备一致），本地仅作缓存 */
  applyCloudConfig() {
    /* 合并云端自定义模型：本地优先，按 key 去重 —— 否则其他客户端解析不了 c: 开头的当前模型 */
    const rawC = S.settings && S.settings['model_custom'];
    if (rawC) {
      try {
        const cloud = JSON.parse(rawC);
        if (Array.isArray(cloud)) {
          const map = new Map(cloud.map(c => [c.key, c]));
          for (const c of this.custom) map.set(c.key, c);
          this.custom = [...map.values()];
          localStorage.setItem('sj_custom_models', JSON.stringify(this.custom));
        }
      } catch (e) { /* */ }
    }
    const raw = S.settings && S.settings['model_config'];
    if (!raw) return;
    try {
      const v = JSON.parse(raw);
      if (v && v.cur) {
        localStorage.setItem('sj_model_cur', v.cur);
        this.savedId = v.cur;
      }
    } catch (e) { /* */ }
  },
  /* 下拉短标签：不带费率后缀（费率只在费率列表展示） */
  shortLabel(m) {
    if (!m) return '（未选择模型）';
    if (m.custom) return `${m.name}·${m.model}（自定义）`;
    return m.name || m.id;   // 不拼 vendor/费率：vendor 是接口返回的单字母缩写，无信息量
  },
  render() {
    const all = this.all();
    let inner;
    if (!all.length) {
      inner = '<option value="">（暂无可选模型）</option>';
    } else {
      const grp = (list, title) => list.length
        ? `<optgroup label="${title}">` + list.map(m => {
            const c = this.creditsText(m);   // 下拉选项带费率数值便于挑选；顶栏徽章不带
            const fee = m.custom ? '' : (c ? `（${c}）` : '');
            return `<option value="${esc(this.modelId(m))}">${esc(this.shortLabel(m) + fee)}</option>`;
          }).join('') + '</optgroup>'
        : '';
      inner = grp(this.platform.map(m => Object.assign({ platform: true }, m)), 'WorkBuddy 平台模型（消耗平台积分）')
            + grp(this.custom.map(c => Object.assign({ custom: true }, c)), '自定义模型（自己的 API Key）');
      /* v3.15.2 未选择时放一个占位项，别让浏览器默认选中第一项造成「看起来选了」 */
      if (!this.cur) inner = '<option value="" selected>— 请选择模型 —</option>' + inner;
    }
    for (const selId of ['modelCurSel']) {
      const sel = $(selId); if (!sel) continue;
      sel.innerHTML = inner;
      sel.value = this.cur ? this.modelId(this.cur) : '';
      sel.disabled = !all.length;
    }
    /* 顶栏：只读展示当前模型，未配置时提示（v3.15.2 点击直达 设置 → 模型） */
    const badge = $('modelBadge');
    if (badge) {
      badge.textContent = this.cur ? this.shortLabel(this.cur) : '未配置';
      badge.style.cursor = 'pointer';
      badge.onclick = () => { switchView('me'); switchSetPane('model'); };
    }
    const st = $('modelStatus');
    if (st) st.textContent = this.loaded
      ? `云端模型 ${this.platform.length} 个、自定义 ${this.custom.length} 个。模型用于「记一笔」AI 解析，云端模型免密钥直接调用。`
      : '模型用于「记一笔」自然语言解析，请先刷新模型列表。';
    const list = $('customModelList');
    if (list) list.innerHTML = this.custom.length ? this.custom.map(c => `
      <div class="mini-item"><div class="mini-main">
        <div class="mini-title">${esc(c.name)}</div>
        <div class="mini-sub">${esc(c.model)} · ${esc(c.baseUrl)}</div>
      </div><div class="mini-right"><button class="icon-btn del cm-del" data-key="${esc(c.key)}" type="button">删除</button></div></div>`).join('')
      : '<div class="empty">暂无自定义模型</div>';
  }
};

/* ---------- LLM 调用（流式，返回完整文本） ---------- */