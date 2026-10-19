/* 技术分析域：K线多源拉取 / 指标计算 / 画图 / 诊断报告（v0.11.0 自单体拆出） */
import { $, toast, fmt2, fmtP, fmtPct, pnlCls, esc, fmtTime, nowLocalInput, inferMarket, MKT_NAME } from '../shared/utils.js';
import { NetLog, sjTokenHeaders } from '../core/netlog.js';
import { StockDict } from '../core/stockdict.js';
import { DL } from '../core/data-layer.js';
import { emQuote, txQuote } from '../sources/quotes.js';
import { ACCESS_KEY, BACKEND_URL, CLOUD_HOST, RPC_BASE, TABLES, cloudStore, loadAll, localStore, rpc, saveSetting, sessionHooks, setStore, storageHooks, store } from '../storage/gateway.js';
import { S } from '../core/app-state.js';
import { computeHoldings, r2 } from './journal.js';
import { llmComplete } from './llm.js';
import { ModelMgr, NetQuote } from './quotes.js';
import { switchView } from '../ui/bind.js';

export function secidOf(code) {
  if (inferMarket(code) === 'bj') return '0.' + code;   // 东财北交所用 0 前缀
  return /^(6|5|9)/.test(code) ? '1.' + code : '0.' + code;
}
export async function fetchKlineEast(code, klt, lmt) {
  /* v3.10.0 fields2 增加 f57（成交额，元）—— K 线库需要逐日成交额做流动性门槛；
     旧字段序列只有 OHLCV，K 线库的「成交额 ≥ 0.5 亿」只能用 收盘×量 近似 */
  const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=' + secidOf(code)
    + '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=' + klt + '&fqt=1&end=20500101&lmt=' + lmt;
  const t0 = Date.now();
  try {
    const res = await fetch(url);
    const j = await res.json();
    const bars = ((j.data && j.data.klines) || []).map(s => {
      const a = s.split(',');
      return { d: a[0], o: +a[1], c: +a[2], h: +a[3], l: +a[4], v: +a[5] || 0, a: +a[6] || 0 };
    });
    NetLog.push('kline', '东财 push2his', bars.length > 0, Date.now() - t0, `${code} klt=${klt} ${bars.length}根`,
      { url, resp: bars.length ? `${bars.length}根 末根 ${bars[bars.length - 1].d} 收${bars[bars.length - 1].c}` : '未获取到（0 根）', err: bars.length ? '' : '未获取到' });
    return { name: (j.data && j.data.name) || code, bars };
  } catch (e) {
    NetLog.push('kline', '东财 push2his', false, Date.now() - t0, `${code} klt=${klt} ${e.message || e}`, { url, err: e.message || String(e) });
    throw e;
  }
}
/* 腾讯日 / 周 K：3 个等价端点轮询（fqkline 路径在高频下可能被 WAF 拦截 501） */
export const KL_URLS = [
  function (sym, period, lmt) { return 'https://ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + sym + ',' + period + ',,,' + lmt + ',qfq'; },
  function (sym, period, lmt) { return 'https://web.ifzq.gtimg.cn/appstock/app/newfqkline/get?param=' + sym + ',' + period + ',,,' + lmt + ',qfq'; },
  function (sym, period, lmt) { return 'https://ifzq.gtimg.cn/appstock/app/newfqkline/get?param=' + sym + ',' + period + ',,,' + lmt + ',qfq'; },
];
export async function fetchKlineTxRaw(code, period, lmt) {
  const sym = inferMarket(code) === 'bj' ? 'bj' + code : inferMarket(code) + code;
  let sawBlock = false, last = { name: code, bars: [] };
  for (const mk of KL_URLS) {
    const t0 = Date.now();
    const url = mk(sym, period, lmt);
    try {
      const res = await fetch(url);
      if (!res.ok) { sawBlock = true; NetLog.push('kline', '腾讯K线', false, Date.now() - t0, `${sym} ${period} HTTP ${res.status}，换端点`, { url, err: 'HTTP ' + res.status }); continue; }
      const txt = await res.text();
      if (!txt || txt.charCodeAt(0) === 60) { sawBlock = true; NetLog.push('kline', '腾讯K线', false, Date.now() - t0, `${sym} ${period} 返回HTML(疑似WAF)，换端点`, { url, err: '返回 HTML（疑似 WAF 拦截）' }); continue; }
      const j = JSON.parse(txt);
      const d = (j.data && j.data[sym]) || {};
      const arr = d[period] || d['qfq' + period] || [];
      const name = (d.qt && d.qt.data && d.qt.data[1]) || last.name;
      if (arr.length) {
        /* v3.9.13 审计：返回摘要带末根日期与收盘价，方便核对 K 线数据准确性 */
        const lastBar = arr[arr.length - 1];
        NetLog.push('kline', '腾讯K线', true, Date.now() - t0, `${sym} ${period} ${arr.length}根`,
          { url, resp: `${arr.length}根 末根 ${lastBar[0]} 收${lastBar[2]}` });
        return {
          name: name, sawBlock: sawBlock,
          bars: arr.map(function (k) { return { d: k[0], o: +k[1], c: +k[2], h: +k[3], l: +k[4], v: +k[5] || 0 }; }),
        };
      }
      NetLog.push('kline', '腾讯K线', false, Date.now() - t0, `${sym} ${period} 空数据，换端点`, { url, err: '未获取到（空数据）' });
      last = { name: name, bars: [] };
    } catch (e) {
      sawBlock = true;
      NetLog.push('kline', '腾讯K线', false, Date.now() - t0, `${sym} ${period} ${e.message || e}，换端点`, { url, err: e.message || String(e) });
    }
  }
  return { name: last.name, bars: last.bars, sawBlock: sawBlock };
}
export async function fetchKlineTx(code, period, lmt) {
  const r = await fetchKlineTxRaw(code, period, lmt);
  if (!r.bars.length && r.sawBlock) throw new Error('腾讯 K 线接口被临时限流，请稍后重试');
  return { name: r.name, bars: r.bars };
}
export async function fetchKline(code, klt, lmt) { // klt: 101 日线 / 102 周线
  const period = klt === 102 ? 'week' : 'day';
  try {
    const r = await fetchKlineTx(code, period, lmt);
    if (r.bars.length > 30) return r;
  } catch (e) { /* 降级东财 */ }
  const r2 = await fetchKlineEast(code, klt, lmt);
  if (r2.bars.length < 30) throw new Error('K 线数据获取失败');
  return r2;
}
/* ---- 指标计算 ---- */
export function calcMA(vals, n) {
  const out = new Array(vals.length).fill(null); let s = 0;
  for (let i = 0; i < vals.length; i++) { s += vals[i]; if (i >= n) s -= vals[i - n]; if (i >= n - 1) out[i] = s / n; }
  return out;
}
export function calcEMA(vals, n) {
  const k = 2 / (n + 1); const out = []; let e = vals[0];
  vals.forEach((v, i) => { e = i ? v * k + e * (1 - k) : v; out.push(e); });
  return out;
}
export function calcMACD(closes) {
  const e12 = calcEMA(closes, 12), e26 = calcEMA(closes, 26);
  const dif = closes.map((_, i) => e12[i] - e26[i]);
  const dea = calcEMA(dif, 9);
  const hist = dif.map((d, i) => (d - dea[i]) * 2);
  return { dif, dea, hist };
}
export function calcRSI(closes, n = 14) {
  const out = new Array(closes.length).fill(null); let g = 0, l = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1], up = Math.max(ch, 0), dn = Math.max(-ch, 0);
    if (i <= n) { g += up; l += dn; if (i === n) out[i] = 100 - 100 / (1 + (g / n) / ((l / n) || 1e-9)); }
    else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; out[i] = 100 - 100 / (1 + g / (l || 1e-9)); }
  }
  return out;
}
export function calcKDJ(bars) {
  const K = [], D = [], J = []; let pk = 50, pd = 50;
  bars.forEach((b, i) => {
    const s = Math.max(0, i - 8); let hh = -Infinity, ll = Infinity;
    for (let k = s; k <= i; k++) { hh = Math.max(hh, bars[k].h); ll = Math.min(ll, bars[k].l); }
    const rsv = hh === ll ? 50 : (b.c - ll) / (hh - ll) * 100;
    const k = pk * 2 / 3 + rsv / 3, d = pd * 2 / 3 + k / 3;
    K.push(k); D.push(d); J.push(3 * k - 2 * d); pk = k; pd = d;
  });
  return { K, D, J };
}
export function calcBOLL(closes, n = 20, k = 2) {
  const mid = calcMA(closes, n);
  const up = new Array(closes.length).fill(null), dn = new Array(closes.length).fill(null);
  let s = 0, s2 = 0;
  for (let i = 0; i < closes.length; i++) {
    s += closes[i]; s2 += closes[i] * closes[i];
    if (i >= n) { s -= closes[i - n]; s2 -= closes[i - n] * closes[i - n]; }
    if (i >= n - 1) {
      const m = s / n;
      const v = Math.max(0, s2 / n - m * m);
      const sd = Math.sqrt(v);
      up[i] = m + k * sd; dn[i] = m - k * sd;
    }
  }
  return { mid, up, dn };
}
export function calcATR(bars, n = 14) {
  const out = new Array(bars.length).fill(null);
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const tr = i === 0 ? (b.h - b.l)
      : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c));
    if (i < n) { sum += tr; out[i] = sum / (i + 1); }
    else out[i] = (out[i - 1] * (n - 1) + tr) / n;
  }
  return out;
}
export function findLevels(bars, price) {
  const n = bars.length, w = 3, his = [], los = [];
  for (let i = w; i < n - w; i++) {
    let isH = true, isL = true;
    for (let k = i - w; k <= i + w; k++) {
      if (k === i) continue;
      if (bars[k].h >= bars[i].h) isH = false;
      if (bars[k].l <= bars[i].l) isL = false;
    }
    if (isH) his.push(bars[i].h);
    if (isL) los.push(bars[i].l);
  }
  const f2 = x => Math.round(x * 100) / 100;
  /* v3.8.5 支撑压力来源标注：聚类 0.6% 内的摆动点计数，多次触碰=密集区，证据更可信 */
  const cluster = arr => {
    const s = [...new Set(arr)].sort((a, b) => a - b);
    const groups = [];
    s.forEach(x => {
      const g = groups[groups.length - 1];
      if (g && Math.abs(x - g[0]) / g[0] < 0.006) g.push(x); else groups.push([x]);
    });
    return groups.map(g => ({ p: f2(g.reduce((s2, x) => s2 + x, 0) / g.length), touches: g.length }));
  };
  const supG = cluster(los.filter(x => x < price * 0.995)).sort((a, b) => b.p - a.p).slice(0, 2);
  const resG = cluster(his.filter(x => x > price * 1.005)).sort((a, b) => a.p - b.p).slice(0, 2);
  return { support: supG.map(g => g.p), resistance: resG.map(g => g.p), supMeta: supG, resMeta: resG };
}
/* ---- 单周期信号引擎（规则投票，每个判断给出理由）---- */
/* v3.8.4 打分引擎重构：按"维度"而非"指标"计数，避免共线性伪确认。
   四个维度：趋势(均线) / 动能(MACD) / 摆动(RSI+KDJ) / 位置(支撑压力)，各计一票。
   趋势维度与摆动维度方向矛盾时（空头趋势+极度超卖等），下调强度并提示技术性反弹。 */
export function analyzeTimeframe(bars, label) {
  const closes = bars.map(b => b.c);
  const i = closes.length - 1, price = closes[i];
  const ma = { 5: calcMA(closes, 5), 10: calcMA(closes, 10), 20: calcMA(closes, 20), 60: calcMA(closes, 60) };
  const macd = calcMACD(closes), rsi = calcRSI(closes), kdj = calcKDJ(bars);
  const levels = findLevels(bars, price);
  const f2 = x => Math.round(x * 100) / 100;
  const ma20 = ma[20][i], ma60 = ma[60][i];
  const h = macd.hist[i], hp = macd.hist[i - 1];
  const r = rsi[i];
  const k = kdj.K[i], d = kdj.D[i], j = kdj.J[i];

  /* —— 维度1：趋势（均线系统，合并为一条证据）—— */
  let tPts = 0; const tParts = [];
  if (ma20 != null) { const p = price > ma20 ? 1 : -1; tPts += p; tParts.push(`收盘${p > 0 ? '站上' : '跌破'} MA20(${f2(ma20)})`); }
  if (ma20 != null && ma60 != null) { const p = ma20 > ma60 ? 1 : -1; tPts += p; tParts.push(`MA20 在 MA60(${f2(ma60)})${p > 0 ? '上' : '下'}方`); }
  if (ma[5][i] != null && ma[10][i] != null) { const p = ma[5][i] > ma[10][i] ? 1 : -1; tPts += p * 0.5; tParts.push(`MA5 ${p > 0 ? '>' : '<'} MA10`); }
  const trendDir = tPts > 0.5 ? 1 : tPts < -0.5 ? -1 : 0;
  const trendW = 3;
  const trendText = `${label}趋势维度：${tParts.join('，')}${trendDir === 1 ? '，中期趋势偏多' : trendDir === -1 ? '，中期趋势偏空' : '，均线纠缠、方向不明'}`;

  /* —— 维度2：动能（MACD，绿柱收敛=空头动能衰竭，不再计入看空；零轴附近设噪声阈值）—— */
  const macdNoise = price * 0.001; /* 柱线绝对值低于股价 0.1% 即视为零轴噪声（不论单日变化），防零轴附近反复横跳 */
  let momDir = 0, momW = 2, momText;
  if (Math.abs(h) < macdNoise) {
    momDir = 0; momW = 0; momText = `MACD 柱线（${f2(h)}）绝对值低于噪声阈值（股价的 0.1%），贴近零轴，动能信号不计分`;
  } else if (h > 0 && h > hp) { momDir = 1; momText = `MACD 红柱扩大（${f2(hp)}→${f2(h)}），多头动能增强`; }
  else if (h > 0) { momDir = 1; momW = 1; momText = `MACD 红柱 ${f2(h)}，多头动能维持但略有减弱`; }
  else if (h < 0 && h < hp) { momDir = -1; momText = `MACD 绿柱扩大（${f2(hp)}→${f2(h)}），空头动能增强`; }
  else if (h < 0 && h > hp && (hp - h) >= macdNoise) { momDir = 0; momW = 0; momText = `MACD 绿柱收敛（${f2(hp)}→${f2(h)}），空头动能衰竭，需警惕止跌反弹（中性观察）`; }
  else if (h < 0) { momDir = 0; momW = 0; momText = `MACD 绿柱 ${f2(h)}，变化幅度过小视为噪声，动能信号不计分`; }
  else { momDir = 0; momW = 1; momText = `MACD 柱线接近零轴，动能中性`; }
  if (macd.dif[i] > 0 && momDir >= 0) { momText += `；DIF(${f2(macd.dif[i])}) 在零轴上方`; }
  else if (macd.dif[i] < 0 && momDir <= 0) { momText += `；DIF(${f2(macd.dif[i])}) 在零轴下方`; }

  /* —— 维度3：摆动/超买超卖（RSI + KDJ 合并为一条证据，取最极端状态）—— */
  let oscDir = 0, oscW = 2, oscText;
  const oversold = (r != null && r < 30) || j < 15;
  const overbought = (r != null && r > 70) || j > 95;
  if (oversold) {
    oscDir = 1; oscW = (r != null && r < 25) || j < 5 ? 3 : 2;
    oscText = `摆动维度极度超卖：RSI=${r != null ? f2(r) : '--'}、J=${f2(j)}，历史上此区域反弹概率偏高`;
  } else if (overbought) {
    oscDir = -1; oscW = (r != null && r > 75) || j > 105 ? 3 : 2;
    oscText = `摆动维度极度超买：RSI=${r != null ? f2(r) : '--'}、J=${f2(j)}，谨防短线冲高回落`;
  } else if (k > d) {
    oscDir = r != null && r > 55 ? 1 : 0; oscW = 1;
    oscText = `KDJ 金叉状态（J=${f2(j)}）${r != null && r > 55 ? `，RSI=${f2(r)} 处于强势区` : '，RSI 中性区，摆动信号不强'}`;
  } else {
    oscDir = r != null && r < 45 ? -1 : 0; oscW = 1;
    oscText = `KDJ 死叉状态（J=${f2(j)}）${r != null && r < 45 ? `，RSI=${f2(r)} 处于弱势区` : '，RSI 中性区，摆动信号不强'}`;
  }

  /* —— 维度4：位置（支撑/压力，独立信息；标注来源与前低触碰次数，密集区证据更强）—— */
  const supMeta = (levels.supMeta || []).find(g => price / g.p < 1.03);
  const resMeta = (levels.resMeta || []).find(g => g.p / price < 1.03);
  const supSrc = supMeta ? `前低摆动点${supMeta.touches >= 2 ? `（${supMeta.touches} 次触碰，密集区）` : ''}` : '';
  const resSrc = resMeta ? `前高摆动点${resMeta.touches >= 2 ? `（${resMeta.touches} 次触碰，密集区）` : ''}` : '';
  let posDir = 0, posW = 0, posText = '';
  if (supMeta && resMeta) { posDir = 0; posW = 1; posText = `${label}现价位于支撑 ${f2(supMeta.p)}${supSrc ? '（' + supSrc + '）' : ''} 与压力 ${f2(resMeta.p)}${resSrc ? '（' + resSrc + '）' : ''} 之间，空间受限`; }
  else if (supMeta) { posDir = 1; posW = supMeta.touches >= 2 ? 2 : 1; posText = `${label}现价贴近支撑位 ${f2(supMeta.p)}，来源：${supSrc || '前低'}，下方抛压相对较小`; }
  else if (resMeta) { posDir = -1; posW = resMeta.touches >= 2 ? 2 : 1; posText = `${label}现价逼近压力位 ${f2(resMeta.p)}，来源：${resSrc || '前高'}，突破前上行空间受限`; }

  const dims = [
    { name: '趋势', dir: trendDir, w: trendDir === 0 ? 0 : trendW, text: trendText },
    { name: '动能', dir: momDir, w: momW, text: momText },
    { name: '摆动', dir: oscDir, w: oscW, text: oscText },
    { name: '位置', dir: posDir, w: posW, text: posText },
  ];
  const reasons = dims.filter(x => x.w > 0 || x.text);

  const raw = dims.reduce((s, x) => s + x.dir * x.w, 0);
  const maxW = dims.reduce((s, x) => s + x.w, 0) || 1;
  let pct = Math.round(raw / maxW * 100);
  /* v3.8.9 计算链全程可见：每一步乘数都记入 steps，明细区展示，输出值=公式值可复现 */
  const steps = [`Σ(方向×权重)=${raw}，Σ权重=${maxW}，基础强度 ${pct}`];
  let caveat = '';
  /* —— 矛盾权重：趋势与摆动维度方向相反时，下调强度并提示反弹/回落 —— */
  if (trendDir === -1 && oversold) {
    pct = Math.round(pct * 0.7);
    steps.push(`矛盾降权×0.7 → ${pct}`);
    caveat = Math.abs(raw / maxW * 100) < 10
      ? '注：趋势维度看空与摆动维度极度超卖方向相反，但基础净分已接近零，实为多空对冲，不构成任一方向的独立依据'
      : '注：空头趋势中摆动指标已达极度超卖，看空强度已下调，可能出现技术性反弹，不宜追空';
  } else if (trendDir === 1 && overbought) {
    pct = Math.round(pct * 0.7);
    steps.push(`矛盾降权×0.7 → ${pct}`);
    caveat = Math.abs(raw / maxW * 100) < 10
      ? '注：趋势维度看多与摆动维度极度超买方向相反，但基础净分已接近零，实为多空对冲，不构成任一方向的独立依据'
      : '注：多头趋势中摆动指标已达极度超买，看多强度已下调，谨防技术性回调，不宜追高';
  }
  if (caveat) reasons.push({ name: '矛盾提示', dir: 0, w: 0, text: caveat });

  /* —— v3.8.4 两段式：量能不直接计分，而是作为强度乘数 + 背离预警。
     防陷阱设计：①用 20 日均量的相对倍数而非单日绝对量；②分类阈值取自该股
     自身近 60 日量比分位数（不同市值/板块换手差异大，不用固定倍数套全市场）；
     ③涨跌停/极端单日波动时量能失真，乘数置 1 并标注；④量价关系是概率性
     修正，只调强度、不单独构成买卖依据。 —— */
  const vol = Number(bars[i].v) || 0;
  const vols = bars.map(b => Number(b.v) || 0);
  const volWin = vols.slice(-21, -1).filter(x => x > 0);
  const volMa = volWin.length ? volWin.reduce((s, x) => s + x, 0) / volWin.length : 0;
  const ratio = volMa > 0 ? vol / volMa : 1;
  /* 该股自身的量比分布（近 60 日：每日量 / 其前 20 日均量），取分位数做自适应阈值 */
  const histRatios = [];
  for (let p = 20; p < vols.length - 1 && p < vols.length; p++) {
    const win = vols.slice(Math.max(0, p - 20), p).filter(x => x > 0);
    if (win.length >= 10 && vols[p] > 0) histRatios.push(vols[p] / (win.reduce((s, x) => s + x, 0) / win.length));
  }
  const qsort = arr => { const a = [...arr].sort((x, y) => x - y); return q => a.length ? a[Math.min(a.length - 1, Math.floor(q * a.length))] : null; };
  const qOf = qsort(histRatios);
  const loThr = (qOf && qOf(0.25)) || 0.7;   /* 缩量线：自身分布 25 分位，缺数据退回 0.7 */
  const hiThr = (qOf && qOf(0.80)) || 1.5;   /* 放量线：自身分布 80 分位，缺数据退回 1.5 */
  const midLo = (loThr + 1) / 2, midHi = (1 + hiThr) / 2;
  const prevC = closes[i - 1] || price;
  const dayDir = price > prevC * 1.001 ? 1 : price < prevC * 0.999 ? -1 : 0;
  const dayChg = prevC > 0 ? (price / prevC - 1) : 0;
  /* 涨跌停/异动检测：单日涨跌幅达 ±9.5%（主板约涨停位）或 ±19%（20cm 品种）附近，量能失真 */
  const isLimitLike = Math.abs(dayChg) >= 0.19 || (Math.abs(dayChg) >= 0.095 && Math.abs(dayChg) < 0.11);
  let volState, mult;
  if (isLimitLike) { volState = dayChg > 0 ? '涨停板（量能失真）' : '跌停板（量能失真）'; mult = 1.0; }
  else if (ratio < loThr * 0.5) { volState = '地量'; mult = 0.5; }
  else if (ratio < loThr) { volState = '缩量'; mult = 0.7; }
  else if (ratio < midLo * 1.0 && ratio >= loThr) { volState = '偏缩量'; mult = 0.85; }
  else if (ratio <= midHi) { volState = '平量'; mult = 1.0; }
  else if (ratio <= hiThr) { volState = '温和放量'; mult = 1.1; }
  else { volState = '显著放量'; mult = 1.2; }
  if (dayDir === 0) mult = Math.min(mult, 1.0); /* 横盘时放量不加分 */
  pct = Math.max(-100, Math.min(100, Math.round(pct * mult)));
  if (mult !== 1) steps.push(`量能×${mult} → ${pct}`);
  /* 量价背离预警：创新低但缩量（抛压衰竭）或放量（恐慌出逃）；停牌复牌日跳过 */
  const recentLows = bars.slice(-20).map(b => Number(b.l) || price);
  const isNewLow = price <= Math.min(...recentLows) * 1.002;
  const prevVol = vols[i - 1] || 0;
  const isResumeDay = prevVol === 0; /* 前一日零量≈停牌复牌，量能不可比 */
  let volNote = `量能：${volState}（现量为 20 日均量的 ${f2(ratio)} 倍，阈值按该股自身近 60 日量比分位数自适应${histRatios.length < 20 ? '，历史不足、暂用通用阈值' : ''}）`;
  if (isResumeDay) volNote = `量能：近期有停牌复牌，单日量能不可比，本次不做量能修正`;
  else if (isLimitLike) volNote += '。涨跌停板附近量能失真（封板/砸板量不代表真实供需），本次不做量能加减分';
  else if (dayDir !== 0) volNote += `，${dayDir > 0 ? '上涨' : '下跌'}${mult > 1 ? '获量能确认' : mult < 1 ? '缺乏量能支撑' : ''}`;
  if (volState === '地量') volNote += '。地量：交投极度冷清，已削弱当前方向净分的信号强度，变盘方向待定';
  if (!isResumeDay && !isLimitLike && isNewLow && ratio < loThr) {
    volNote += '。量价背离：股价创新低但明显缩量，抛压趋于衰竭，历史统计上此处加速下跌概率下降、注意止跌信号（概率性修正，非买卖依据）';
    pct = Math.round(pct * 0.7);
    steps.push(`背离再降×0.7 → ${pct}`);
  } else if (!isResumeDay && !isLimitLike && isNewLow && ratio > hiThr) {
    volNote += '。放量破位创新低，恐慌性抛售特征，短期或有惯性下探（概率性提示，非买卖依据）';
  }
  reasons.push({ name: '量能', dir: 0, w: 0, text: volNote });

  const signal = pct >= 30 ? 'buy' : pct <= -30 ? 'sell' : 'hold';
  const summary = reasons.filter(x => x.dir !== 0).slice(0, 3).map(x => x.text).join('；');
  return { label, price, ma, macd, rsi: r, kdj: { K: k, D: d, J: j }, levels, reasons, raw, maxW, pct, signal, summary, caveat, dims, steps, volInfo: { state: volState, ratio, mult } };
}
/* v3.8.5 修复一致性判断 bug：原来按 buy/sell/hold 三档比较，+10 与 -10 都落 hold 档
   被误判为"方向一致"。现按强度符号比较；|综合|<5 强制输出观望；并披露合成公式。 */
export function combineTechSignal(d, w) {
  const pct = Math.round(d.pct * 0.6 + w.pct * 0.4); /* 公开公式：日线×60% + 周线×40% */
  let signal = pct >= 30 ? 'buy' : pct <= -30 ? 'sell' : 'hold';
  const ds = Math.sign(d.pct), ws = Math.sign(w.pct);
  let agree;
  if (ds !== 0 && ds === ws) {
    agree = ds > 0 ? '日线与周线方向一致看多，信号可信度较高' : '日线与周线方向一致看空，信号可信度较高';
  } else if (ds !== 0 && ws !== 0 && ds !== ws) {
    agree = ds > 0
      ? '日线反弹信号与周线下跌趋势冲突，属于逆势反弹，可信度偏低，仓位需谨慎'
      : '日线回落与周线上涨趋势冲突，可能是周线上行中的回踩，注意日线企稳信号';
  } else {
    agree = '日线或周线一方强度接近零轴、方向不明，信号强度有限';
  }
  let note = agree;
  if (Math.abs(pct) < 5) {
    signal = 'hold';
    note = `多空胶着（综合强度 ${pct > 0 ? '+' : ''}${pct}，接近零轴），方向不明，建议观望，不宜据此建仓`;
  }
  return { pct, signal, agree, note };
}
export function fmtVol(v) {
  const n = Number(v) || 0;
  if (n >= 1e8) return (n / 1e8).toFixed(2) + ' 亿手';
  if (n >= 1e4) return (n / 1e4).toFixed(2) + ' 万手';
  return Math.round(n) + ' 手';
}
/* ---- 蜡烛图绘制（红涨绿跌；主图 + 成交量副图 + 悬停十字光标）---- */
export const KC_UP = '#e03131', KC_DOWN = '#12b76a';
export function drawCandleChart(canvas, bars, count, an, hover) {
  const wrap = canvas.parentElement;
  const tip = wrap ? wrap.querySelector('.kchart-tip') : null;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 800, H = canvas.clientHeight || 340;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const data = bars.slice(-count);
  if (!data.length) { canvas._kc = null; if (tip) tip.hidden = true; return; }
  const vis = k => (an && an.ma && an.ma[k]) ? an.ma[k].slice(-count) : null;
  const maLines = [
    { k: 5, v: vis(5), c: '#f0a020', t: 'MA5' },
    { k: 10, v: vis(10), c: '#e0559a', t: 'MA10' },
    { k: 20, v: vis(20), c: '#3b82f6', t: 'MA20' },
    { k: 60, v: vis(60), c: '#10b981', t: 'MA60' },
  ];
  let min = Math.min(...data.map(b => b.l)), max = Math.max(...data.map(b => b.h));
  maLines.forEach(m => { if (!m.v) return; m.v.forEach(v => { if (v != null) { min = Math.min(min, v); max = Math.max(max, v); } }); });
  if (!isFinite(min) || !isFinite(max)) { min = 0; max = 1; }
  if (max - min < 1e-9) { max += 1; min -= 1; }
  const pad = (max - min) * 0.06; min -= pad; max += pad;
  const lvTags = [];
  an.levels.support.forEach((p, i) => { if (p >= min && p <= max) lvTags.push({ p, no: i + 1, kind: 'sup', line: 'rgba(224,48,48,.55)' }); });
  an.levels.resistance.forEach((p, i) => { if (p >= min && p <= max) lvTags.push({ p, no: i + 1, kind: 'res', line: 'rgba(10,157,78,.55)' }); });
  const supLs = lvTags.filter(t => t.kind === 'sup'), resLs = lvTags.filter(t => t.kind === 'res');
  const lgLines = [{ kind: 'ma' }];
  if (supLs.length) lgLines.push({ kind: 'lv', ls: supLs, color: 'rgba(224,48,48,.95)', label: '支撑' });
  if (resLs.length) lgLines.push({ kind: 'lv', ls: resLs, color: 'rgba(10,157,78,.95)', label: '压力' });
  const lgTop = 12, lgGap = 17;
  const padT = lgTop + lgGap * (lgLines.length - 1) + 12;
  const padL = 8, padR = 56, axisH = 20;
  const plotW = Math.max(40, W - padL - padR);
  const bodyH = Math.max(120, H - padT - axisH - 8);
  const volH = Math.max(44, Math.round(bodyH * 0.24));
  const gapH = 12;
  const priceH = Math.max(60, bodyH - volH - gapH);
  const priceTop = padT, priceBot = padT + priceH;
  const volTop = priceBot + gapH, volBot = volTop + volH;
  const y = p => priceTop + (max - p) / (max - min) * priceH;
  const maxVol = Math.max(1, ...data.map(b => Number(b.v) || 0));
  const vh = v => Math.max(1, (Number(v) || 0) / maxVol * volH);
  const step = plotW / data.length;
  const xc = i => padL + step * i + step / 2;
  ctx.font = '11px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.textBaseline = 'middle';
  for (let g = 0; g <= 4; g++) {
    const p = max - (max - min) * g / 4, yy = y(p);
    ctx.strokeStyle = 'rgba(128,128,128,.15)'; ctx.beginPath();
    ctx.moveTo(padL, yy); ctx.lineTo(padL + plotW, yy); ctx.stroke();
    ctx.fillStyle = '#8a8f98'; ctx.textAlign = 'left';
    ctx.fillText(p.toFixed(2), padL + plotW + 6, yy);
  }
  ctx.strokeStyle = 'rgba(128,128,128,.22)'; ctx.beginPath();
  ctx.moveTo(padL, volBot); ctx.lineTo(padL + plotW, volBot); ctx.stroke();
  ctx.fillStyle = '#9aa0a8'; ctx.textAlign = 'left';
  ctx.fillText('成交量', padL + 2, volTop - 7);
  ctx.fillText(fmtVol(maxVol), padL + plotW + 6, volTop + 4);
  ctx.setLineDash([5, 4]);
  lvTags.forEach(t => {
    ctx.strokeStyle = t.line; ctx.beginPath();
    ctx.moveTo(padL, y(t.p)); ctx.lineTo(padL + plotW, y(t.p)); ctx.stroke();
  });
  ctx.setLineDash([]);
  data.forEach((b, i) => {
    const x = xc(i);
    const up = b.c >= b.o, col = up ? KC_UP : KC_DOWN;
    ctx.strokeStyle = col; ctx.fillStyle = col;
    ctx.beginPath(); ctx.moveTo(x, y(b.h)); ctx.lineTo(x, y(b.l)); ctx.stroke();
    const bw = Math.max(1.5, step * 0.62);
    const yo = y(b.o), yc = y(b.c);
    if (up) ctx.fillRect(x - bw / 2, yc, bw, Math.max(1, yo - yc));
    else ctx.fillRect(x - bw / 2, yo, bw, Math.max(1, yc - yo));
  });
  data.forEach((b, i) => {
    const x = xc(i);
    const up = b.c >= b.o, col = up ? KC_UP : KC_DOWN;
    const h2 = vh(b.v);
    const bw = Math.max(1.5, step * 0.62);
    ctx.fillStyle = col; ctx.globalAlpha = 0.72;
    ctx.fillRect(x - bw / 2, volBot - h2, bw, h2);
    ctx.globalAlpha = 1;
  });
  maLines.forEach(m => {
    if (!m.v) return;
    ctx.strokeStyle = m.c; ctx.lineWidth = 1.2; ctx.beginPath();
    let started = false;
    m.v.forEach((v, i) => {
      if (v == null) return;
      const x = xc(i);
      if (!started) { ctx.moveTo(x, y(v)); started = true; } else ctx.lineTo(x, y(v));
    });
    ctx.stroke(); ctx.lineWidth = 1;
  });
  ctx.fillStyle = '#8a8f98'; ctx.textAlign = 'center';
  const tickN = Math.min(7, data.length);
  for (let g = 0; g < tickN; g++) {
    const idx = Math.floor(g * (data.length - 1) / Math.max(1, tickN - 1));
    ctx.fillText(data[idx].d.slice(5), xc(idx), volBot + 12);
  }
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  lgLines.forEach((ln, i) => {
    const ly = lgTop + lgGap * i;
    if (ln.kind === 'ma') {
      let lx = padL + 2;
      maLines.forEach(m => { ctx.fillStyle = m.c; ctx.fillText(m.t, lx, ly); lx += 44; });
      return;
    }
    const items = ln.ls.map(t => ln.label + t.no + ': ' + t.p.toFixed(2));
    let txt = items.join('　');
    if (ctx.measureText(txt).width > plotW - 6 && items.length > 1) txt = items[0] + ' 等' + items.length + '档';
    ctx.fillStyle = ln.color;
    ctx.fillText(txt, padL + 2, ly);
  });
  const hoverIdx = (hover && hover.idx != null && hover.idx >= 0 && hover.idx < data.length) ? hover.idx : null;
  if (hoverIdx != null) {
    const hx = xc(hoverIdx), b = data[hoverIdx];
    ctx.strokeStyle = 'rgba(90,100,115,.55)'; ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(hx, priceTop); ctx.lineTo(hx, volBot); ctx.stroke();
    const cy = y(b.c);
    ctx.setLineDash([]);
    ctx.fillStyle = '#5a6473';
    const lab = b.c.toFixed(2);
    ctx.fillRect(padL + plotW + 2, cy - 8, Math.max(52, ctx.measureText(lab).width + 10), 16);
    ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(lab, padL + plotW + 6, cy + 0.5);
    if (hover.y != null && hover.y >= priceTop && hover.y <= priceBot) {
      ctx.strokeStyle = 'rgba(90,100,115,.35)';
      ctx.beginPath(); ctx.moveTo(padL, hover.y); ctx.lineTo(padL + plotW, hover.y); ctx.stroke();
      const pv = max - (hover.y - priceTop) / priceH * (max - min);
      const t2 = pv.toFixed(2);
      ctx.fillStyle = 'rgba(90,100,115,.9)';
      ctx.fillRect(padL + plotW + 2, hover.y - 8, Math.max(52, ctx.measureText(t2).width + 10), 16);
      ctx.fillStyle = '#fff'; ctx.fillText(t2, padL + plotW + 6, hover.y + 0.5);
    }
    ctx.strokeStyle = 'rgba(37,99,235,.9)'; ctx.lineWidth = 1.2;
    ctx.strokeRect(hx - step * 0.45, priceTop, Math.max(2, step * 0.9), priceH);
    ctx.lineWidth = 1;
  }
  canvas._kc = { padL, step, n: data.length, data, priceTop, priceBot, volTop, volBot, W, H };
  if (tip) {
    if (hoverIdx == null) { tip.hidden = true; }
    else {
      const i = hoverIdx, b = data[i], iOff = bars.length - data.length;
      const prev = (iOff + i - 1 >= 0) ? bars[iOff + i - 1] : null;
      const pctChg = prev && prev.c ? (b.c - prev.c) / prev.c * 100 : null;
      const cls = b.c >= b.o ? 'up' : 'down';
      const chgCls = pctChg == null ? '' : (pctChg >= 0 ? 'up' : 'down');
      const amp = b.o ? (b.h - b.l) / b.o * 100 : 0;
      const r2 = n => (n == null ? '—' : Number(n).toFixed(2));
      tip.innerHTML =
        `<div class="kt-head">${esc(b.d)}${pctChg == null ? '' : `<span class="kt-chg ${chgCls}">${pctChg >= 0 ? '+' : ''}${pctChg.toFixed(2)}%</span>`}</div>`
        + `<div class="kt-grid">`
        + `<span>开</span><b>${r2(b.o)}</b><span>高</span><b>${r2(b.h)}</b>`
        + `<span>低</span><b>${r2(b.l)}</b><span>收</span><b class="${cls}">${r2(b.c)}</b>`
        + `<span>量</span><b>${fmtVol(b.v)}</b><span>振幅</span><b>${amp.toFixed(2)}%</b>`
        + `</div>`
        + `<div class="kt-ma">`
        + maLines.map(m => `<span style="color:${m.c}">${m.t}</span><b>${m.v && m.v[i] != null ? Number(m.v[i]).toFixed(2) : '—'}</b>`).join('')
        + `</div>`;
      tip.hidden = false;
      const tw = tip.offsetWidth || 242, th = tip.offsetHeight || 104;
      const axisX = padL + plotW;
      const cx = xc(i);
      let left = cx + 16;
      if (left + tw > axisX - 4) left = cx - 16 - tw;
      if (left + tw > axisX - 4) left = axisX - 4 - tw;
      if (left < 2) left = 2;
      let top = (hover && hover.y != null ? hover.y : priceTop) - th / 2;
      top = Math.max(2, Math.min(H - th - 2, top));
      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
    }
  }
}
export function bindKchartHover(canvas, bars, count, an) {
  if (!canvas) return;
  let raf = 0, pending = null;
  const flush = () => {
    raf = 0;
    if (!pending) return;
    drawCandleChart(canvas, bars, count, an, pending);
    pending = null;
  };
  const onMove = (clientX, clientY) => {
    const st = canvas._kc;
    if (!st) return;
    const r = canvas.getBoundingClientRect();
    const x = clientX - r.left, y = clientY - r.top;
    let idx = Math.floor((x - st.padL) / st.step);
    idx = Math.max(0, Math.min(st.n - 1, idx));
    pending = { idx, y };
    if (!raf) raf = requestAnimationFrame(flush);
  };
  canvas.onpointermove = e => onMove(e.clientX, e.clientY);
  canvas.onpointerdown = e => onMove(e.clientX, e.clientY);
  canvas.onpointerleave = () => {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    pending = null;
    drawCandleChart(canvas, bars, count, an, null);
  };
}
export function redrawAnalysisCanvases() {
  const g = S.diag;
  if (g) {
    const gd = $('diagDailyCv'), gw = $('diagWeeklyCv');
    if (gd && gd.clientWidth) drawCandleChart(gd, g.daily.bars, 120, g.d);
    if (gw && gw.clientWidth) drawCandleChart(gw, g.weekly.bars, 60, g.w);
  }
}
export let _techResizeTimer = 0;
export function bindTechResize() {
  if (window._techResizeBound) return;
  window._techResizeBound = true;
  window.addEventListener('resize', () => {
    clearTimeout(_techResizeTimer);
    _techResizeTimer = setTimeout(redrawAnalysisCanvases, 180);
  });
}
/* ---- 股票下拉（自选 + 持仓，按代码去重）---- */
/* v3.8.6 个股诊断改为自绘下拉（原生 select 弹层受系统深色模式影响，深色下渲染成黑块） */
export let diagPickCode = '';
export function renderAnalysisSelect() {
  const list = $('stockPickList'), label = $('stockPickLabel');
  if (!list || !label) return;
  const mk = new Map();
  computeHoldings().forEach(h => { if (h.qty > 0 && h.code) mk.set(h.code, h.name || h.code); });
  S.watchlist.forEach(w => { if (w.stock_code && !mk.has(w.stock_code)) mk.set(w.stock_code, w.stock_name || w.stock_code); });
  const entries = [...mk.entries()];
  if (!entries.some(([c]) => c === diagPickCode)) diagPickCode = entries.length ? entries[0][0] : '';
  list.innerHTML = entries.map(([c, n]) =>
    `<div class="selpick-item${c === diagPickCode ? ' on' : ''}" data-code="${esc(c)}" data-name="${esc(n)}">${esc(n)}（${esc(c)}）</div>`
  ).join('') || '<div class="selpick-empty">请先在自选股或持仓中添加股票</div>';
  const cur = mk.get(diagPickCode);
  label.textContent = cur ? `${cur}（${diagPickCode}）` : '请先添加自选或持仓';
}
export function bindStockPick() {
  const wrap = $('stockPick'), btn = $('stockPickBtn'), list = $('stockPickList');
  if (!wrap || !btn || !list) return;
  const close = () => { wrap.classList.remove('open'); list.hidden = true; };
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const opening = list.hidden;
    if (opening) { wrap.classList.add('open'); list.hidden = false; }
    else close();
  });
  list.addEventListener('click', e => {
    const it = e.target.closest('.selpick-item');
    if (!it || !it.dataset.code) return;
    diagPickCode = it.dataset.code;
    const lb = $('stockPickLabel');
    lb.textContent = `${it.dataset.name}（${it.dataset.code}）`;
    list.querySelectorAll('.selpick-item').forEach(x => x.classList.toggle('on', x === it));
    close();
  });
  document.addEventListener('click', e => { if (!wrap.contains(e.target)) close(); });
}
bindStockPick();
/* ---- 一键个股诊断 ---- */
export async function diagnoseStock(forceCode) {
  const code = (typeof forceCode === 'string' ? forceCode : diagPickCode).trim();
  if (!code) return toast('请先在自选股或持仓中添加股票');
  const btn = $('stockAnalyzeBtn');
  const box = $('diagBox');
  if (!box) return;
  btn.disabled = true; btn.textContent = '诊断中…';
  box.hidden = false;
  box.innerHTML = '<p class="hint">正在获取 K 线与行情、计算技术指标…</p>';
  /* v3.9.13 审计：整段诊断里的网络调用都标上触发来源 */
  return NetLog.withCtx('个股诊断·' + code, async () => {
  try {
    const [daily, weekly] = await Promise.all([fetchKline(code, 101, 260), fetchKline(code, 102, 180)]);
    if (!daily.bars.length || !weekly.bars.length) throw new Error('K 线数据不足，无法诊断');
    const d = analyzeTimeframe(daily.bars, '日线');
    const w = analyzeTimeframe(weekly.bars, '周线');
    const comb = combineTechSignal(d, w);
    try { await NetQuote.refresh(); } catch (e) { /* 行情失败不阻断技术面 */ }
    const q = NetQuote.get(code);
    const h = computeHoldings().find(x => x.code === code) || null;
    const pos = h && h.qty > 0 ? { qty: h.qty, avgCost: h.costValue / h.qty } : null;
    const name = (daily.name && daily.name !== code && /[\u4e00-\u9fa5]/.test(daily.name) ? daily.name : null)
      || (h && h.name) || (q && q.name) || code;
    S.diag = { code, name, daily, weekly, d, w, comb, q, pos, ai: '', busy: false };
    renderDiagView();
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) {
    S.diag = null;
    box.innerHTML = '<p class="hint">' + esc(e && e.message || '诊断失败，请重试') + '</p>';
  } finally {
    btn.disabled = false; btn.textContent = '开始诊断';
  }
  });
}
window.analyzeStockByCode = async function (code) {
  switchView('analysis');
  diagPickCode = code;
  renderAnalysisSelect();
  await diagnoseStock(code);
};
export function renderDiagView() {
  const t = S.diag;
  const box = $('diagBox');
  if (!t || !box) return;
  box.hidden = false;
  box.innerHTML = diagHtml();
  const cvD = $('diagDailyCv'), cvW = $('diagWeeklyCv');
  drawCandleChart(cvD, t.daily.bars, 120, t.d);
  drawCandleChart(cvW, t.weekly.bars, 60, t.w);
  bindKchartHover(cvD, t.daily.bars, 120, t.d);
  bindKchartHover(cvW, t.weekly.bars, 60, t.w);
  bindTechResize();
  /* v3.8.11 K 线数据下载（CSV：日期,开,收,高,低,成交量） */
  const dlK = (bars, fname) => {
    const head = '日期,开盘,收盘,最高,最低,成交量\n';
    const body = bars.map(b => [b.d, b.o, b.c, b.h, b.l, b.v].join(',')).join('\n');
    const blob = new Blob(['\ufeff' + head + body], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  };
  const dDlD = $('kDlDaily'), dDlW = $('kDlWeekly');
  if (dDlD) dDlD.onclick = () => dlK(t.daily.bars, `${t.code}_${t.name || ''}_日线K.csv`);
  if (dDlW) dDlW.onclick = () => dlK(t.weekly.bars, `${t.code}_${t.name || ''}_周线K.csv`);
  $('diagCloseBtn').onclick = closeDiag;
  $('diagSaveBtn').onclick = saveDiagReport;
  $('diagAiBtn').onclick = () => runDiagAi();
  syncDiagAiBtn();
}
export function syncDiagAiBtn() {
  const btn = $('diagAiBtn');
  const t = S.diag;
  if (!btn) return;
  btn.disabled = !!(t && t.busy);
  btn.textContent = t && t.busy ? '生成中…' : (t && t.ai ? '↻ 重新生成解读' : '🤖 生成 AI 综合解读');
}
export function closeDiag() {
  const t = S.diag;
  const box = $('diagBox');
  if (!box || !t) return;
  const sig = t.comb.signal === 'buy' ? '买入' : t.comb.signal === 'sell' ? '卖出' : '持有';
  box.innerHTML = `
    <div class="diag-folded">
      <span class="diag-folded-txt">🩺 个股诊断：<b>${esc(t.name)}（${esc(t.code)}）</b> · 技术面 ${sig}（${t.comb.pct > 0 ? '+' : ''}${t.comb.pct}）${t.ai ? '' : ' · 尚未生成 AI 解读'}</span>
      <span class="diag-folded-act">
        <button id="diagReopenBtn" class="btn ghost sm">展开</button>
        <button id="diagDropBtn" class="btn ghost sm">关闭</button>
      </span>
    </div>`;
  $('diagReopenBtn').onclick = reopenDiag;
  $('diagDropBtn').onclick = dropDiag;
}
export function reopenDiag() {
  if (!S.diag) return toast('请先开始诊断');
  renderDiagView();
  const box = $('diagBox');
  if (box) box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
export function dropDiag() {
  const box = $('diagBox');
  if (box) { box.hidden = true; box.innerHTML = ''; }
  S.diag = null;
}
export function diagHtml() {
  const t = S.diag;
  if (!t) return '';
  const { name, code, d, w, comb, q, pos } = t;
  const qLine = q && q.price != null
    ? `实时行情 最新 ${q.price}，涨跌幅 ${q.pct > 0 ? '+' : ''}${q.pct}%`
    : '实时行情获取失败（技术面仍基于历史 K 线）';
  const posLine = pos
    ? `你的持仓 ${fmt2(pos.qty)} 股，成本 ${fmt2(pos.avgCost)}`
    : '你当前未持仓这只股票';
  const reasonLi = (r) => r.dir === 0
    ? `<li class="r-neu">◦ 中性（${r.name}）：${esc(r.text)}</li>`
    : `<li class="${r.dir > 0 ? 'r-bull' : 'r-bear'}">${r.dir > 0 ? '▲ 看多' : '▼ 看空'}（${r.name} +${r.w}）：${esc(r.text)}</li>`;
  return `
    <div class="card-title-row">
      <span class="card-title">🩺 个股诊断：${esc(name)}（${esc(code)}）</span>
      <button id="diagCloseBtn" class="btn ghost sm">收起</button>
    </div>
    <div class="tech-signal">
      <div class="sig-badge sig-${comb.signal}">${comb.signal === 'buy' ? '买入' : comb.signal === 'sell' ? '卖出' : '持有'}</div>
      <div class="sig-score">
        <div><b>${esc(name)}（${esc(code)}）</b>　${esc(qLine)}</div>
        <div>技术面综合强度 <b>${comb.pct > 0 ? '+' : ''}${comb.pct}</b>（日线 ${d.pct > 0 ? '+' : ''}${d.pct} × 60% ＋ 周线 ${w.pct > 0 ? '+' : ''}${w.pct} × 40%）</div>
        <div class="dw-status">当前状态：日线${d.pct > 0 ? '偏多' : d.pct < 0 ? '偏空' : '多空对冲（净信号为零，非无信号）'} / 周线${w.pct > 0 ? '偏多' : w.pct < 0 ? '偏空' : '多空对冲（净信号为零，非无信号）'}${(() => { const ds = Math.sign(d.pct), ws = Math.sign(w.pct); return ds !== 0 && ds === ws ? '，两周期方向一致' : ds !== 0 && ws !== 0 ? '，两周期方向冲突' : '，一方方向不明'; })()}${Math.abs(comb.pct) < 5 ? '，落入观望区' : ''}${(() => { const cs = Math.sign(comb.pct), ds = Math.sign(d.pct), ws = Math.sign(w.pct); if (cs === 0) return ''; const dir = cs > 0 ? '偏多' : '偏空'; if (ds === 0 && ws === cs) return `；综合${dir}完全由周线贡献`; if (ws === 0 && ds === cs) return `；综合${dir}完全由日线贡献`; return ''; })()}</div>
        <div>${esc(posLine)}</div>
        <div>${esc(comb.note)}</div>
      </div>
    </div>
    <div class="tech-charts">
      <div class="tech-chart-block">
        <h4>日线 K 线（近 120 日）<span class="k-dl" id="kDlDaily" data-k="d" title="下载 CSV（含成交量）">⬇ 下载</span><span class="kc-hint">鼠标移到图上查看当日价格与成交量</span></h4>
        <div class="kchart-wrap"><canvas id="diagDailyCv"></canvas><div class="kchart-tip" hidden></div></div>
      </div>
      <div class="tech-chart-block">
        <h4>周线 K 线（近 60 周）<span class="k-dl" id="kDlWeekly" data-k="w" title="下载 CSV（含成交量）">⬇ 下载</span><span class="kc-hint">鼠标移到图上查看当周价格与成交量</span></h4>
        <div class="kchart-wrap"><canvas id="diagWeeklyCv"></canvas><div class="kchart-tip" hidden></div></div>
      </div>
    </div>
    <div class="levels-legend">关键价位：<b>支撑</b> ${d.levels.support.length ? d.levels.support.join(' / ') : '近 3 年低点下方'} ／ <b>压力</b> ${d.levels.resistance.length ? d.levels.resistance.join(' / ') : '近 3 年高点上方'}　<span class="lv-note">（K 线图左上角图例只标出落在当前可见区间内的档位，档号与这里一一对应）</span></div>
    <div class="tech-cols">
      <div class="tech-reason"><h4>📉 日线信号明细（强度 ${d.pct > 0 ? '+' : ''}${d.pct}）</h4>${d.steps && d.steps.length ? `<div class="calc-chain">计算链：${d.steps.join(' → ')}</div>` : ''}<ul>${d.reasons.map(reasonLi).join('')}</ul></div>
      <div class="tech-reason"><h4>📊 周线信号明细（强度 ${w.pct > 0 ? '+' : ''}${w.pct}）</h4>${w.steps && w.steps.length ? `<div class="calc-chain">计算链：${w.steps.join(' → ')}</div>` : ''}<ul>${w.reasons.map(reasonLi).join('')}</ul></div>
    </div>
    <div class="formula-note">强度合成公式（可复现，明细区附每一步计算链）：单周期强度 = Σ(维度方向×权重) ÷ Σ该周期实际计分权重 × 100。四维度权重表：趋势 3（均线三条件合成，方向由合计点数定）、动能 2（红/绿柱走弱降为 1，|柱线|&lt;股价0.1% 判噪声记 0）、摆动 2（深度极值 RSI&lt;25 或 J&lt;5 升为 3；金叉/死叉但 RSI 中性降为 1 且方向记 0；矛盾触发用较宽阈值 RSI&lt;30/J&lt;15，不影响权重）、位置 1（密集区支撑/压力升为 2；各周期统一计算，无贴近摆动点位时该维度不计入分母）。再乘量能系数（地量 0.5 / 缩量 0.7 / 偏缩量 0.85 / 平量 1.0 / 温和放量 1.1 / 显著放量 1.2，阈值取个股自身近 60 日量比分位数；涨跌停与停牌复牌不做修正；地量削弱的是当前净分方向）。矛盾降权触发条件（写死）：趋势维度与摆动维度符号相反，且摆动处于极端区（RSI&lt;30 或 J&lt;15；反向为 RSI&gt;70 或 J&gt;95）→ 强度 ×0.7。综合强度 = 日线 × 60% + 周线 × 40%（两周期同公式同量纲），|综合| &lt; 5 强制观望。</div>
    <div class="diag-ai">
      <div class="diag-ai-title">🤖 综合诊断 <span class="diag-ai-sub">技术面 ＋ 基本面 ＋ 你的持仓与交易行为，只给一个结论</span></div>
      <div id="diagAiOut" class="diag-ai-out">${t.ai ? esc(t.ai) : (t.busy ? '生成中…' : '<span class="diag-ai-idle">技术面已经出好了。点下面的按钮，再结合基本面、消息面与你的持仓 / 交易行为，生成一段可执行的操作建议。</span>')}</div>
      <div class="diag-ai-actions">
        <button id="diagAiBtn" class="btn primary">${t.ai ? '↻ 重新生成解读' : '🤖 生成 AI 综合解读'}</button>
        <button id="diagSaveBtn" class="btn ghost">💾 保存到报告历史</button>
      </div>
    </div>`;
}
export async function runDiagAi() {
  const t = S.diag;
  if (!t) return;
  if (t.busy) return;
  const paint = (txt) => {
    if (S.diag !== t) return;
    const el = $('diagAiOut');
    if (el) el.textContent = txt;
  };
  t.busy = true;
  syncDiagAiBtn();
  paint('生成中…');
  const { d, w, comb, name, code, q, pos } = t;
  const last = (a) => (a && a.length ? Math.round(a[a.length - 1] * 100) / 100 : '-');
  const anDesc = (an) => `${an.label}：现价 ${an.price}，RSI=${an.rsi == null ? '-' : Math.round(an.rsi)}，KDJ K=${Math.round((an.kdj && an.kdj.K) || 0)}/D=${Math.round((an.kdj && an.kdj.D) || 0)}/J=${Math.round((an.kdj && an.kdj.J) || 0)}，MACD DIF=${last(an.macd && an.macd.dif)}/DEA=${last(an.macd && an.macd.dea)}，强度 ${an.pct}；信号要点（按维度归类）：${an.reasons.filter(r => r.dir !== 0).map(r => (r.dir > 0 ? '看多' : '看空') + '【' + r.name + '】' + r.text).join('；')}${an.caveat ? '。' + an.caveat : ''}`;
  const myTrades = S.trades.filter(x => x.stock_code === code).slice(0, 10)
    .map(x => `${String(x.transaction_time || '').slice(0, 16)} ${x.transaction_type === 'buy' ? '买入' : '卖出'} ${x.quantity}股 @${x.price}`);
  const sys = `你是资深证券分析师。用户已经在界面上看到了技术指标与 K 线图，你不需要复述原始数值。
请输出一份结构清晰的「个股诊断」，纯文本 Markdown，全文 600 字以内，严格分四节：
一、技术面小结（用一句话概括日线＋周线的位置关系，并说明关键支撑/压力对操作的实际意义）
二、基本面与消息面视角（基于你的知识，注明信息可能滞后）
三、结合该用户持仓与交易行为的个性化提醒
四、操作建议（给出可执行的分步动作：什么价位做什么、止损位、加减仓条件）
最后单独一行写：以上分析由 AI 生成，仅供参考，不构成投资建议。`;
  const user = `股票：${name}（${code}）
实时行情：${q && q.price != null ? `最新价 ${q.price}，涨跌幅 ${q.pct}%` : '（获取失败，请基于你的知识分析并说明数据可能滞后）'}
技术面规则信号：${comb.signal === 'buy' ? '买入' : comb.signal === 'sell' ? '卖出' : '持有'}（综合强度 ${comb.pct}）｜${comb.note}
关键价位：支撑 ${d.levels.support.join(' / ') || '近 3 年低点下方'}；压力 ${d.levels.resistance.join(' / ') || '近 3 年高点上方'}
${anDesc(d)}
${anDesc(w)}
用户持仓：${pos ? `${fmt2(pos.qty)} 股，成本价 ${fmt2(pos.avgCost)}` : '未持仓'}
用户近期交易：
${myTrades.join('\n') || '无记录'}`;
  try {
    let text = '';
    const ret = await llmComplete([
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ], {
      onDelta: (delta) => { text += delta; paint(text); },
    });
    t.ai = (typeof ret === 'string' && ret) ? ret : text;
    paint(t.ai || '（无输出）');
  } catch (e) {
    paint('综合诊断生成失败：' + (e && e.message || '请稍后重试'));
  } finally {
    t.busy = false;
    syncDiagAiBtn();
  }
}
/* ---- 报告历史（localStorage，本机保存最近 30 条）---- */
export const DIAG_HIST_KEY = 'sj_diag_reports_v1';
export function loadDiagHistory() { try { return JSON.parse(localStorage.getItem(DIAG_HIST_KEY) || '[]'); } catch (e) { return []; } }
export function saveDiagHistoryItem(item) {
  const list = loadDiagHistory();
  list.unshift(item);
  try { localStorage.setItem(DIAG_HIST_KEY, JSON.stringify(list.slice(0, 30))); } catch (e) { /* */ }
  renderDiagHistory();
}
export function renderDiagHistory() {
  const el = $('diagHistory');
  if (!el) return;
  const list = loadDiagHistory();
  if (!list.length) { el.innerHTML = ''; return; }
  el.innerHTML = '<div class="card-title-row" style="margin-top:4px"><span class="card-title" style="font-size:13px">诊断报告历史（本机保存）</span>'
    + '<button class="btn ghost sm" id="diagHistClear" type="button">清空</button></div>'
    + list.map((r, i) => `<div class="mini-item diag-hist-item" data-i="${i}"><div><b>${esc(r.title)}</b><span class="hint">${esc(r.time)}</span></div><span class="pct ${r.sig === '买入' ? 'pos' : r.sig === '卖出' ? 'neg' : 'neu'}">${esc(r.sig)} ${r.pct > 0 ? '+' : ''}${r.pct}</span></div>`).join('');
  $('diagHistClear').onclick = () => { localStorage.removeItem(DIAG_HIST_KEY); renderDiagHistory(); toast('报告历史已清空'); };
  el.querySelectorAll('.diag-hist-item').forEach(item => {
    item.onclick = () => {
      const r = loadDiagHistory()[+item.dataset.i];
      if (!r) return;
      const box = $('diagBox');
      box.hidden = false;
      box.innerHTML = `<div class="card-title-row"><span class="card-title">${esc(r.title)}</span><button class="btn ghost sm" onclick="document.getElementById('diagBox').hidden=true">关闭</button></div><div class="diag-ai-out" style="margin-top:10px">${esc(r.content)}</div>`;
      box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
  });
}
export async function saveDiagReport() {
  const t = S.diag;
  if (!t) return;
  const sig = t.comb.signal === 'buy' ? '买入' : t.comb.signal === 'sell' ? '卖出' : '持有';
  const content = [
    `综合信号：${sig}（技术面强度 ${t.comb.pct}）`,
    t.comb.note,
    `关键价位：支撑 ${t.d.levels.support.join(' / ') || '近 3 年低点下方'}；压力 ${t.d.levels.resistance.join(' / ') || '近 3 年高点上方'}`,
    '',
    `【日线信号（${t.d.pct > 0 ? '+' : ''}${t.d.pct}）】`,
    ...t.d.reasons.map(r => (r.dir > 0 ? '▲ ' : '▼ ') + r.text),
    '',
    `【周线信号（${t.w.pct > 0 ? '+' : ''}${t.w.pct}）】`,
    ...t.w.reasons.map(r => (r.dir > 0 ? '▲ ' : '▼ ') + r.text),
    t.ai ? '\n【综合诊断】\n' + t.ai : '',
  ].join('\n');
  saveDiagHistoryItem({
    title: `个股诊断：${t.name}（${t.code}）`,
    time: new Date().toLocaleString('zh-CN', { hour12: false }),
    sig, pct: t.comb.pct, content,
  });
  toast(t.ai ? '诊断已保存到报告历史' : '已保存技术面结论（AI 解读还没生成）');
}
/* ---- 模块初始化（DOM 就绪后直接绑定；boot() 在本文件末尾执行）---- */
(function initAnalysis() {
  $('stockAnalyzeBtn').onclick = () => diagnoseStock();
  renderDiagHistory();
})();


/* ============================================================
   v3.9.0 智能问答（核心对话）
   来源：trade-manager-97288。迁移「核心对话」这一层：
     多轮对话 / 流式输出 / 历史记录（云端 qa_history）/ 搜索 / 新对话 /
     附件上传 / 语音输入 / Markdown 渲染 / 基于持仓与交易的上下文注入。
   v3.9.7 起另补上「工具取数层」（独立文件 qa-tools.js，见该文件头注释）：
     条件选股 / 板块成分股 / 实时行情 / 财务估值 / 五维诊断 / 技术分析 / 组合风险 /
     操作复盘 / 策略回测 / K 线相似度 —— 全部走公开免费接口，无需任何 Key。
   仍未迁移（源站有、本项目按需摘除）：
     · 妙想（mx）技能中心、凭证管理与依赖 Key 的技能；问答范围设置与视觉模型选择
     · maybeRecordFromQa（从问答自动记一笔）
   适配点：命名沿用 stock-journal 习惯（sj_ 前缀）、复用 store/S/esc/toast，
          LLM 走现有 ModelMgr + llmComplete，仅额外补一个可中止的流式封装。
   ============================================================ */
