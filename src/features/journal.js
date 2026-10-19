/* 记账域：费用引擎 / 记录渲染 / 记账表单 / 自然语言解析（v0.11.0 自单体拆出） */
import { $, toast, fmt2, fmtP, fmtPct, pnlCls, esc, fmtTime, nowLocalInput, inferMarket, MKT_NAME } from '../shared/utils.js';
import { doLogout } from './auth.js';
import { NetLog, sjTokenHeaders } from '../core/netlog.js';
import { StockDict } from '../core/stockdict.js';
import { DL } from '../core/data-layer.js';
import { emQuote, txQuote } from '../sources/quotes.js';
import { TABLES, BACKEND_URL, RPC_BASE, ACCESS_KEY, CLOUD_HOST, rpc, cloudStore, localStore, setStore, loadAll, saveSetting, sessionHooks, storageHooks } from '../storage/gateway.js';
import { S } from '../core/app-state.js';
import { U } from '../core/ui-state.js';
import { cloudLlm } from '../app.js';
import { llmComplete, nowStr } from './llm.js';
import { feeOpenIds, stockDetailRow, stockOpenCodes } from './overview.js';
import { ModelMgr, NetQuote, refreshQuotes } from './quotes.js';
import { syncGroupList } from './watchlist.js';

export const DEFAULT_FEES = {
  sh:  { rate: 0.06, min: 5, stamp: 0.5, transfer: 0.01, handling: 0.034, gov: 0.02 },
  sz:  { rate: 0.06, min: 5, stamp: 0.5, transfer: 0.01, handling: 0.034, gov: 0.02 },
  bse: { rate: 0.06, min: 0, stamp: 0.5, transfer: 0.01, handling: 0.125, gov: 0 }
};
export function feeCfg(market) {
  /* 键名归一：inferMarket 产出 'bj'，费率表键为 'bse'（v3.8.32 修 —— 此前北交所单会误落到深市费率） */
  const key = market === 'bj' ? 'bse' : market;
  const cfg = S.settings.fee || {};
  return Object.assign({}, DEFAULT_FEES[key] || DEFAULT_FEES.sz, cfg[key] || {});
}
/* v3.8.31 场内基金（ETF/LOF）费率：固定佣金万1全包（含规费）、免印花税、最低5元
   依据广发交割单 1445 笔实测：纳斯达克ETF 49笔全部 = 金额×0.0001（<500元按5元收） */
export const FUND_FEES = { rate: 0.1, min: 5, stamp: 0, transfer: 0, handling: 0, gov: 0 };
export function isFundCode(code) { return !!code && /^(5|1[56])/.test(String(code)); }
/* v3.8.32 口径改为「券商式逐项取整」：每个费用项先四舍五入到分，再汇总计入总费用
   （依据广发交割单 1445 笔实测：该口径对账吻合率 62.5%，优于原「各项高精度相加后取整」的 57.4%，
   且分项之和天然等于合计，费用明细不再出现 1 分钱对不上） */
export const r2 = x => Math.round((x + 1e-9) * 100) / 100;
export function calcFees(amount, type, market, code) {
  /* 最低费用 min 针对规费(过户+经手+证管)+佣金 合计，不足时由佣金补足；印花税不参与 */
  const f = (market === 'fund' || isFundCode(code)) ? FUND_FEES : feeCfg(market);
  const stamp = type === 'sell' ? r2(amount * f.stamp / 1000) : 0;
  const transfer = r2(amount * f.transfer / 1000);
  const gov = r2(amount * (f.gov || 0) / 1000);
  const handling = r2(amount * f.handling / 1000);
  const rawComm = r2(amount * f.rate / 1000);
  const fixTotal = transfer + gov + handling;
  const minFee = Number(f.min) || 0;
  const comm = amount > 0 && (fixTotal + rawComm) < minFee ? r2(Math.max(minFee - fixTotal, 0)) : rawComm;
  return { commission: comm, stamp, transfer, handling, gov, total: r2(stamp + fixTotal + comm) };
}
/* 初始持仓记录（费用手动置 0，成本=初始建仓价）：不参与「重算历史费用」，避免成本被改写 */
export function isInitTrade(t) {
  if (!t) return false;
  if (/初始化/.test(t.note || '')) return true;
  const f = t.fee;
  return !!f && typeof f === 'object' && Object.keys(f).length === 0;
}
export function buildTradeRow({ type, code, name, market, price, qty, time, note }) {
  const gross = Math.round(price * qty * 10000) / 10000;
  const fee = calcFees(gross, type, market, code);
  const net = type === 'buy' ? gross + fee.total : gross - fee.total;
  return {
    transaction_time: new Date(time).toISOString(),
    transaction_type: type,
    stock_code: code, stock_name: name || '', market,
    quantity: qty, price, gross_amount: gross, fee, net_amount: net,
    note: note || '', source: 'manual'
  };
}

/* ============================================================
   持仓引擎：移动加权平均（统计权威）+ 摊薄成本（展示）
   ============================================================ */
export function computeHoldings() {
  const map = new Map();
  const sorted = [...S.trades].sort((a, b) => new Date(a.transaction_time) - new Date(b.transaction_time));
  /* v3.8.56 当日配对池：卖出时优先用「同日买入」的成本配对，剩余部分才回落到历史持仓成本。
     目的：做 T（当日买、当日卖）时「已实现盈亏」反映这一手操作的真实收益，
     而不是拿隔夜老仓的高成本去比（那会得出与直觉相反的巨额亏损）。
     dayKey = 本地交易日 YYYY-MM-DD，日切时重置池。 */
  let dayKey = '', dayQty = 0, dayCost = 0;
  for (const t of sorted) {
    const k = t.stock_code;
    if (!map.has(k)) map.set(k, { code: k, name: t.stock_name || '', market: t.market, qty: 0, costValue: 0, dilutedValue: 0, realized: 0, realizedOp: 0, timeline: [] });
    const h = map.get(k);
    if (t.stock_name) h.name = t.stock_name;
    if (t.market) h.market = t.market;
    const feeTotal = (t.fee && t.fee.total) || 0;
    const net = t.net_amount != null ? Number(t.net_amount) : t.gross_amount - feeTotal;
    /* 日切：换了一天就清空配对池（按该笔自身的交易日期） */
    const d = new Date(t.transaction_time);
    const tKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (tKey !== dayKey) { dayKey = tKey; dayQty = 0; dayCost = 0; }
    if (t.transaction_type === 'buy') {
      h.qty += t.quantity;
      h.costValue += t.gross_amount + feeTotal;      // 加权：费用计入成本
      h.dilutedValue += t.gross_amount + feeTotal;
      dayQty += t.quantity; dayCost += t.gross_amount + feeTotal;
      h.timeline.push({ t, avg: h.qty ? h.costValue / h.qty : 0, realized: null, realizedOp: null });
    } else {
      const avg = h.qty ? h.costValue / h.qty : 0;
      const pnl = net - t.quantity * avg;            // 整轮口径：这笔卖 vs 持仓加权成本
      h.realized += pnl;
      /* 当笔口径：先用当日买入池配对，剩余部分再用历史加权成本 */
      let pnlOp;
      if (dayQty > 0) {
        const useQty = Math.min(t.quantity, dayQty);
        const avgDay = dayCost / dayQty;
        pnlOp = useQty * ((net / t.quantity) - avgDay); // 配对部分：卖出净价 − 当日买入成本
        dayCost -= useQty * avgDay; dayQty -= useQty;
        const rest = t.quantity - useQty;
        if (rest > 0) pnlOp += rest * ((net / t.quantity) - avg);
      } else {
        pnlOp = pnl;
      }
      h.realizedOp += pnlOp;
      h.costValue -= t.quantity * avg;
      h.dilutedValue -= net;                          // 摊薄：盈亏滚入
      h.qty -= t.quantity;
      if (h.qty <= 0.0001) { h.qty = 0; h.costValue = 0; h.dilutedValue = 0; }
      h.timeline.push({ t, avg, realized: pnl, realizedOp: pnlOp });
    }
  }
  return [...map.values()];
}
export function quoteMap() {
  return NetQuote.map;   // 统一走网络行情（腾讯公开接口），不再读手填价格表
}

/* ============================================================
   v3.8.23 网络日志：所有网络调用（云RPC / 行情 / K线）统一记录
   内存环 + localStorage 持久化；「我的 → 数据管理」可下载 .log 文件
   ============================================================ */
/* v3.9.13 网络日志升级为「审计级」：此前每条只有 kind/name/ms/detail，
   看不出「哪个功能触发的、调了哪个接口、参数是什么、返回了什么」，
   股票数据没法核对准确性。现在每条记录带：
   src（触发来源：功能·操作，由 NetLog.withCtx 压栈自动带上）
   url（请求地址）req（请求参数摘要）resp（返回摘要）err（失败原因）
   取不到数据时如实记 FAIL + 原因，绝不静默编造。 */
/* v3.15.1 自托管 API 统一带会话 token（公网部署时服务端校验 x-sj-token） */

/* ============================================================
   网络行情（v3.8.24 东财主源 + 腾讯备选，浏览器可直连）
   v3.8.24：新浪 hq.sinajs.cn 服务端白名单校验 Referer（必须是新浪系
   域名），浏览器无法伪造 → 永远 403，弃用；改用东财 push2 实时快照
   （无 Referer/UA 要求，已实测浏览器可直连、批量、秒级时间戳）。
   map: code -> { price, name, pct, prevClose, open, high, low }
   获取失败的代码不在 map 中；quoteTime 为行情商报价时间
   ============================================================ */
export function tradeParseSys() {
  return `你是证券交易记录解析器，把用户描述的交易操作解析为 JSON，只输出 JSON。
当前时间：${nowStr()}（"今天/现在"以此为准）。
充分发挥你的证券知识，完成以下解析：
1. 逐笔拆分用户描述中的每笔交易，准确判断买卖方向（action: "buy" 或 "sell"）。
2. quantity 输出股数：A股 1手=100股（"5手"=500股）；price 输出每股成交价。两者都是纯数字，不要千分位逗号、不要带"股/手/元"等单位，不要把成交金额填进来。
3. 根据股票名称给出股票代码：A股为 6 位数字。**必须逐位核对代码，不确定就填空字符串**——
   相近代码极易混淆（如 603395「红四方」与 603393「新天然气」、600xxx 与 603xxx）；
   宁可留空也不要写一个不确定的代码，本地会用股票名称自动校正。
   但 stock_name 必填，且一律用交易所简称（如「中兴通讯」），不要写工商全称。
4. trade_date 输出 "YYYY-MM-DD HH:MM:SS"，从描述推断成交时间：含具体时间（如"14:23""9月25日上午10点半"）→ 解析成对应时间；只说"上午/早上"且没给时刻 → 该日 08:00:00；只说"下午/午后" → 该日 16:00:00；完全没提 → 用上面的当前时间。
5. 无法确定的字段置 null，不要编造。
输出格式：
{"trades":[{"stock_code":"","stock_name":"","action":"buy","quantity":0,"price":0,"trade_date":"YYYY-MM-DD HH:MM:SS"}],"summary":"一句话总结本次记录"}`;
}
export function extractJson(text) {
  const t = String(text || '').replace(/```json|```/g, '').trim();
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i < 0 || j <= i) throw new Error('模型未返回 JSON');
  return JSON.parse(t.slice(i, j + 1));
}
export function cleanNum(v) {
  const m = String(v ?? '').replace(/[,，\s]/g, '').match(/-?\d+(\.\d+)?/);
  return m ? m[0] : '';
}
/* 解析结果 → 待确认列表（统一结构 {type,code,name,market,qty,price,time}） */
export function normalizeParsed(j) {
  const list = (j.trades || []).map(t => {
    if (!t || (!t.stock_code && !t.stock_name) || !t.action) return null;
    const qty = Number(cleanNum(t.quantity)), price = Number(cleanNum(t.price));
    if (!(qty > 0) || !(price > 0)) return null;
    const code = String(t.stock_code || '').trim();
    let time = nowLocalInput();
    if (t.trade_date && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(String(t.trade_date))) {
      const d = new Date(String(t.trade_date).replace(' ', 'T'));
      if (!isNaN(d)) time = toLocalInput(d);   // 转本地时间（此前 toISOString 是 UTC，差 8 小时）
    }
    return { type: t.action === 'sell' ? 'sell' : 'buy', code, name: String(t.stock_name || '').trim(), market: inferMarket(code), qty, price, time };
  }).filter(Boolean);
  if (!list.length) throw new Error('未解析出有效交易（需要：方向、数量、价格、股票）');
  return list.map(reconcileParsedCode);
}
/* ---------- v3.8.60 AI 解析结果以本地字典校正代码 ----------
   问题：prompt 允许模型「凭证券知识」直接给代码，而模型会把相近代码记混
   （实测「红四方」被解析成 603393，603393 实为「新天然气」），原实现原样采信、
   静默入库 —— 名称与代码张冠李戴，还会经 learnFromState() 污染整本字典。
   做法：拿到 code + name 后回查字典做一致性校正，分三种情形：
     · 代码有效但名称不符 → 以名称为准，用名称反查正确代码（本例即此，603393→603395）
     · 代码有效且名称相符 → 保留
     · 代码无效/未填但有名称 → 用名称反查补全
   校正结果挂在 `_fix` 上，由待确认列表提示用户「已自动纠正」，不静默改写。 */
export function reconcileParsedCode(t) {
  if (!t) return t;
  if (!StockDict.ready) return t;            // 字典未就绪：不猜，原样返回
  const name = String(t.name || '').trim();
  let code = String(t.code || '').trim();
  let fix = null;
  if (!name) return t;                       // 没名称无从校正，原样返回
  const byCode = code ? StockDict.d[code] : null;
  if (code && byCode && byCode.name === name) return t;   // 代码与名称相符
  /* 名称反查（精确名优先，其次 search 首命中） */
  let hit = null;
  for (const c in StockDict.d) { if (StockDict.d[c].name === name) { hit = c; break; } }
  if (!hit) { const s = StockDict.search(name, 1); hit = s.length ? s[0].code : null; }
  if (hit && hit !== code) {
    fix = { from: code || '(空)', to: hit, reason: byCode ? `代码 ${code} 实为「${byCode.name}」` : '代码缺失或有误' };
    code = hit;
  } else if (!hit && code && !StockDict.d[code]) {
    fix = { from: code, to: code, reason: '该代码不在股票字典中，请确认', keep: true };
  }
  return Object.assign({}, t, { code, market: inferMarket(code), _fix: fix });
}
/* Date → 本地 "YYYY-MM-DDTHH:mm"（datetime-local 口径） */
export function toLocalInput(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function resToList(res) {
  return { type: res.type, code: res.code || '', name: res.name || '', market: res.market || inferMarket(res.code || ''), qty: res.qty, price: res.price, time: nowLocalInput() };
}

/* 本地规则解析（保留：AI 不可用时的兜底） */
export function parseTradeText(raw) {
  const t = (raw || '').trim();
  if (!t) return null;
  const res = {};
  if (/买|购入|建仓|加仓/.test(t)) res.type = 'buy';
  else if (/卖|出掉|抛|减仓|清仓/.test(t)) res.type = 'sell';

  let m = t.match(/(\d+(?:\.\d+)?)\s*手/);
  if (m) res.qty = Math.round(parseFloat(m[1]) * 100);
  if (!res.qty) {
    m = t.match(/(\d+(?:\.\d+)?)\s*股/);
    if (m) res.qty = Math.round(parseFloat(m[1]));
  }

  m = t.match(/(?:单价|价格|价位|成本)\s*(\d+(?:\.\d+)?)/)
    || t.match(/@\s*(\d+(?:\.\d+)?)/)
    || t.match(/(\d+(?:\.\d+)?)\s*(?:块|元)/)
    || t.match(/(?:^|\s)(\d+(?:\.\d+)?)\s*(?:买入|卖出|买|卖)/)
    || t.match(/(?:买入|卖出|买|卖)(?:价)?\s*(\d+(?:\.\d+)?)/);
  if (m) res.price = parseFloat(m[1]);

  m = t.match(/\b([0-9]{6})\b/) || t.match(/\b([0-9]{5})\b/);
  if (m) { res.code = m[1]; res.market = inferMarket(res.code); }

  const names = (t.match(/[\u4e00-\u9fa5]{2,8}/g) || [])
    .filter(s => !/[买卖股手块元单价价格成本现价]/.test(s));
  if (names.length) res.name = names.sort((a, b) => b.length - a.length)[0];

  if (!res.type || res.price == null || !res.qty || (!res.code && !res.name)) return null;
  return res;
}

/* ---------- 解析入口：AI 优先，失败回落本地规则 ---------- */
export let pendingTrades = [];
export async function aiParseEntry(inputId, hintId) {
  const raw = $(inputId).value.trim();
  if (!raw) return;
  setManualOpen(false);   // 解析时收起手动录入区
  const el = $(hintId);
  el.hidden = false;
  el.className = 'quick-hint';
  const model = ModelMgr.cur;
  const aiReady = model && (model.custom || cloudLlm);
  if (!aiReady) {
    const res = parseTradeText(raw);
    if (!res) {
      el.className = 'quick-hint warn';
      el.innerHTML = esc(model ? '本地规则未能识别出交易信息。' : '尚未选择模型（设置 → AI 模型），本地规则也未能识别。')
        + '请重新输入，或 <button class="link-btn p-open-manual" type="button">手动录入</button>';
      return;
    }
    renderPending(hintId, inputId, [resToList(res)], '（本地规则识别，请核对）');
    return;
  }
  el.innerHTML = `AI 解析中（${esc(ModelMgr.shortLabel(model))}）…`;
  try {
    const text = await llmComplete([{ role: 'system', content: tradeParseSys() }, { role: 'user', content: raw }]);
    const list = normalizeParsed(extractJson(text));
    if (!list.length) {
      el.className = 'quick-hint warn';
      el.innerHTML = '未能解析出交易信息，请换个说法重新输入，或 <button class="link-btn p-open-manual" type="button">手动录入</button>';
      return;
    }
    renderPending(hintId, inputId, list, '');
  } catch (e) {
    const res = parseTradeText(raw);
    if (res) {
      renderPending(hintId, inputId, [resToList(res)], '');
      el.insertAdjacentHTML('afterbegin', `<div class="p-warn">AI 解析失败（${esc(e.message || '未知错误')}），以下为本地规则结果：</div>`);
    } else {
      el.className = 'quick-hint warn';
      el.innerHTML = 'AI 解析失败：' + esc(e.message || '未知错误') + '。请重新输入，或 <button class="link-btn p-open-manual" type="button">手动录入</button>';
    }
  }
}
export function renderPending(hintId, inputId, list, summary) {
  pendingTrades = list;
  const el = $(hintId);
  el.className = 'quick-hint';
  el.innerHTML = (summary ? `<div class="p-sum">${esc(summary)}</div>` : '')
    + (list.length > 1 ? `<div class="p-saveall-row"><button class="btn primary sm p-saveall-btn" data-close="0" type="button">全部保存</button><button class="btn primary sm p-saveall-btn" data-close="1" type="button">全部保存并关闭（${list.length} 笔）</button></div>` : '')
    + `<div class="pending-list">` + list.map((t, i) => `
      <div class="p-item">
        <span class="tag ${t.type}">${t.type === 'buy' ? '买入' : '卖出'}</span>
        <span class="p-desc">${esc(t.name || t.code)} ${t.qty} 股 @${esc(t.price)} · ${esc(String(t.time).replace('T', ' ').slice(0, 16))}${t.code ? ` <span class="p-code">${esc(t.code)}</span>` : ''}</span>
        ${t._fix ? `<span class="p-fix${t._fix.keep ? ' warn' : ''}">${t._fix.keep ? esc(t._fix.reason) : `已纠正代码 ${esc(t._fix.from)} → ${esc(t._fix.to)}（${esc(t._fix.reason)}）`}</span>` : ''}
        <span class="p-btns">
          <button class="btn primary sm p-save-btn" data-hint="${hintId}" data-input="${inputId}" data-i="${i}" data-close="0" type="button">保存</button>
          ${list.length === 1 ? `<button class="btn primary sm p-save-btn" data-hint="${hintId}" data-input="${inputId}" data-i="${i}" data-close="1" type="button">保存并关闭</button>` : ''}
          <button class="btn ghost sm pfill-btn" data-hint="${hintId}" data-input="${inputId}" data-i="${i}" type="button">改</button>
        </span>
      </div>`).join('') + `</div>`;
}

/* ============================================================
   启动与认证
   ============================================================ */
sessionHooks.onExpired = () => { try { doLogout(true); } catch (e) { /* */ } };
storageHooks.afterLoad = () => { try { syncGroupList(); } catch (e) { /* */ } };
/* ============================================================
   渲染
   ============================================================ */
export function tradeRowFiltered() {
  const from = $('ftFrom').value, to = $('ftTo').value;
  const allKw = $('ftKw').value.trim().toLowerCase();   // 全字段搜索：代码/名称/备注/原始语句/金额数量
  return S.trades.filter(t => {
    if (t.source === 'init') return false; /* 初始化持仓不进交易流水 */
    const d = t.transaction_time.slice(0, 10);
    if (from && d < from) return false;
    if (to && d > to) return false;
    if (allKw) {
      const hay = `${t.stock_code} ${t.stock_name || ''} ${t.note || ''} ${t.raw_text || ''} ${t.transaction_type === 'buy' ? '买入 卖' : '卖出 买'} ${t.quantity} ${t.price} ${t.gross_amount}`.toLowerCase();
      if (!hay.includes(allKw)) return false;
    }
    return true;
  });
}
/* 交易视图模式：list=默认（逐笔），stock=按股票汇总 */

export const TRADE_HEAD_LIST = '<th>时间</th><th>方向</th><th>股票</th><th class="num">价格</th><th class="num">数量</th>'
  + '<th class="num">成交金额</th><th class="num">费用</th><th class="num">发生金额</th><th>操作</th>';
export const TRADE_HEAD_STOCK = '<th>股票</th><th class="num">成交量(买/卖)</th><th class="num">成交均价(买/卖)</th>'
  + '<th class="num">成交额</th><th class="num">买/卖笔数</th><th class="num">费用</th>';
export function renderTrades() {
  const rows = tradeRowFiltered();
  $('tradeEmpty').hidden = rows.length > 0;
  $('tradeTheadRow').innerHTML = U.tradeMode === 'stock' ? TRADE_HEAD_STOCK : TRADE_HEAD_LIST;
  /* 按股票：时间范围内按代码汇总，点行展开每笔明细 + 期间总盈亏 */
  if (U.tradeMode === 'stock') {
    /* 每笔已实现盈亏：从持仓引擎 timeline 取（卖出时有值） */
    const pnlById = new Map(), holdByCode = new Map();
    for (const h of computeHoldings()) {
      holdByCode.set(h.code, h);
      for (const ev of h.timeline) if (ev.realized != null && ev.t) pnlById.set(String(ev.t.id), ev.realized);
    }
    const m = new Map();
    for (const t of rows) {
      const k = t.stock_code;
      if (!m.has(k)) m.set(k, { code: k, name: t.stock_name || k, qty: 0, amt: 0, fee: 0, buys: 0, sells: 0, buyQty: 0, buyAmt: 0, sellQty: 0, sellAmt: 0, trades: [] });
      const g = m.get(k);
      g.qty += t.quantity || 0;
      g.amt += t.gross_amount || 0;
      g.fee += (t.fee && t.fee.total) || 0;
      if (t.transaction_type === 'buy') { g.buys++; g.buyQty += t.quantity || 0; g.buyAmt += t.gross_amount || 0; }
      else { g.sells++; g.sellQty += t.quantity || 0; g.sellAmt += t.gross_amount || 0; }
      g.trades.push(t);
    }
    U.lastStockAgg = m;
    const list = [...m.values()].sort((a, b) => b.amt - a.amt);
    $('tradeTable').querySelector('tbody').innerHTML = list.map(g => `
      <tr class="stockagg" data-code="${esc(g.code)}" title="点击展开每笔明细与期间盈亏">
        <td><div class="stock-cell"><span class="sc-name">${esc(g.name)}</span><span class="sc-code">${esc(g.code)}</span></div></td>
        <td class="num">${g.buyQty || '—'} / ${g.sellQty || '—'}</td>
        <td class="num">${g.buyQty ? fmt2(g.buyAmt / g.buyQty) : '—'} / ${g.sellQty ? fmt2(g.sellAmt / g.sellQty) : '—'}</td>
        <td class="num">${fmt2(g.amt)}</td>
        <td class="num">${g.buys} / ${g.sells}</td>
        <td class="num">${fmt2(g.fee)}</td>
      </tr>`).join('');
    /* 恢复已展开的股票明细 */
    if (stockOpenCodes.size) {
      for (const tr of $('tradeTable').querySelectorAll('tbody tr.stockagg')) {
        if (!stockOpenCodes.has(tr.dataset.code)) continue;
        const g = U.lastStockAgg.get(tr.dataset.code);
        if (g) tr.insertAdjacentHTML('afterend', stockDetailRow(g));
      }
    }
    const stats = $('ftStats');
    if (stats) stats.innerHTML = `<span>${list.length} 只股票</span><span>共 <b>${rows.length}</b> 笔</span><span>点股票行可展开每笔明细</span>`;
    return;
  }
  $('tradeTable').querySelector('tbody').innerHTML = rows.map(t => {
    const fee = (t.fee && t.fee.total) || 0;
    const d = new Date(t.transaction_time), p2 = n => String(n).padStart(2, '0');
    const dateStr = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    const timeStr = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
    return `<tr data-id="${t.id}">
      <td class="tm-cell">${dateStr}<br><span class="tm-sub">${timeStr}</span></td>
      <td><span class="tag ${t.transaction_type}">${t.transaction_type === 'buy' ? '买入' : '卖出'}</span></td>
      <td><div class="stock-cell"><span class="sc-name">${esc(t.stock_name || '')}</span><span class="sc-code">${esc(t.stock_code)}</span></div></td>
      <td class="num">${fmt2(t.price)}</td>
      <td class="num">${t.quantity}</td>
      <td class="num">${fmt2(t.gross_amount)}</td>
      <td class="num fee-cell" data-id="${t.id}" title="点击展开费用明细">${fmt2(fee)}</td>
      <td class="num">${fmt2(Math.abs(t.net_amount != null ? t.net_amount : t.gross_amount - fee))}</td>
      <td><div class="row-actions">
        <button class="icon-btn edit-trade" data-id="${t.id}">编辑</button>
        <button class="icon-btn del del-trade" data-id="${t.id}">删除</button>
      </div></td>
    </tr>`;
  }).join('');
  /* 恢复已展开的费用明细行（重渲染后保持，直到用户再点一次收起） */
  if (feeOpenIds.size) {
    for (const tr of $('tradeTable').querySelectorAll('tbody tr[data-id]')) {
      if (!feeOpenIds.has(String(tr.dataset.id))) continue;
      const t = S.trades.find(x => String(x.id) === String(tr.dataset.id));
      if (t) tr.insertAdjacentHTML('afterend', feeDetailRow(t));
    }
  }
  /* 筛选结果汇总 */
  const stats = $('ftStats');
  if (stats) {
    if (!rows.length) { stats.innerHTML = ''; return; }
    const buyAmt = rows.filter(t => t.transaction_type === 'buy').reduce((s, t) => s + (t.gross_amount || 0), 0);
    const sellAmt = rows.filter(t => t.transaction_type === 'sell').reduce((s, t) => s + (t.gross_amount || 0), 0);
    const fees = rows.reduce((s, t) => s + ((t.fee && t.fee.total) || 0), 0);
    stats.innerHTML = `<span>共 <b>${rows.length}</b> 笔</span><span>买入 <b>${fmt2(buyAmt)}</b></span><span>卖出 <b>${fmt2(sellAmt)}</b></span><span>费用合计 <b>${fmt2(fees)}</b></span><span>净买入 <b class="${pnlCls(buyAmt - sellAmt)}">${fmt2(buyAmt - sellAmt)}</b></span>`;
  }
}
export function feeDetailRow(t) {
  const f = t.fee || {};
  return `<tr class="fee-detail-row"><td></td><td colspan="8">
    <div class="fee-preview">
      <span>佣金 <b>${fmt2(f.commission || 0)}</b></span>
      <span>印花税 <b>${fmt2(f.stamp || 0)}</b></span>
      <span>过户费 <b>${fmt2(f.transfer || 0)}</b></span>
      <span>经手费 <b>${fmt2(f.handling || 0)}</b></span>
      <span>证管费 <b>${fmt2(f.gov || 0)}</b></span>
      <span>合计 <b>${fmt2(f.total || 0)}</b></span>
      ${t.note ? `<span>备注：${esc(t.note)}</span>` : ''}
    </div></td></tr>`;
}
export function fillTradeForm(t) {
  S.editingTradeId = t.id;
  $('tfType').value = t.transaction_type;
  setTfStock(t.stock_code, t.stock_name || '');
  $('tfPrice').value = t.price;
  $('tfQty').value = t.quantity;
  const d = new Date(t.transaction_time), p = n => String(n).padStart(2, '0');
  $('tfTime').value = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  $('tfNote').value = t.note || '';
  $('tfSubmit').textContent = '保存修改';
  /* 编辑模式锁定：只允许改备注/理由，买卖方向、股票、价格、数量、时间不可改 */
  ['tfPrice', 'tfQty', 'tfTime', 'tfStock'].forEach(id => { const el = $(id); if (el) el.readOnly = true; });
  $('tfType').disabled = true;
  document.querySelectorAll('#tfTypeTabs .wtab').forEach(x => x.disabled = true);
  document.querySelectorAll('#tradeForm input, #tradeForm select').forEach(el => el.classList.add('lock-dim'));
  $('tfNote').classList.remove('lock-dim');
  const hint = $('tfEditHint');
  if (hint) hint.hidden = false;
  setManualOpen(true);
  updateFeePreview();
  openRecModal(false);
}
export function unlockTradeForm() {
  ['tfPrice', 'tfQty', 'tfTime', 'tfStock'].forEach(id => { const el = $(id); if (el) el.readOnly = false; });
  const sel = $('tfType'); if (sel) sel.disabled = false;
  document.querySelectorAll('#tfTypeTabs .wtab').forEach(x => x.disabled = false);
  document.querySelectorAll('#tradeForm .lock-dim').forEach(el => el.classList.remove('lock-dim'));
  const hint = $('tfEditHint');
  if (hint) hint.hidden = true;
}
export function resetTradeForm() {
  S.editingTradeId = null;
  unlockTradeForm();
  $('tradeForm').reset();
  setTfStock('', '');
  $('tfTime').value = nowLocalInput();
  $('tfSubmit').textContent = '保存';
  updateFeePreview();
}
/* 「记一笔」弹窗 */
/* 记一笔弹窗滚到底（保存按钮可见） */
export function scrollRecBottom() {
  const m = document.querySelector('#recModal .modal-lg');
  if (!m || $('recModal').hidden) return;
  const doScroll = () => { m.scrollTop = m.scrollHeight; };
  requestAnimationFrame(doScroll);
  setTimeout(doScroll, 120);   // 布局（如手机键盘/费用预览撑高）稳定后再校准一次
}
/* 键盘弹出时视口变小：弹窗高度跟随可视视口，保存按钮不会被键盘挡住 */
(function () {
  const vv = window.visualViewport;
  if (!vv) return;
  let t = null;
  const fit = () => {
    const m = document.querySelector('#recModal .modal-lg');
    if (!m || $('recModal').hidden) return;
    m.style.maxHeight = Math.max(200, Math.round(vv.height - 16)) + 'px';
    m.scrollTop = m.scrollHeight;   // 高度变化后保持在底部
  };
  vv.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(fit, 80); });
  vv.addEventListener('scroll', () => { clearTimeout(t); t = setTimeout(fit, 80); });
})();
/* v3.8.55 记一笔弹窗：自然语言区与手动录入区互为手风琴——
   展开手动录入时收起上面的自然语言区（含快捷 chip），收起手动录入时再放回来。
   两边不会同时展开，弹窗不会又长又乱，也被迫让用户明确选一种录入方式。 */
export function setNlOpen(open) {
  const w = $('nlWrap');
  if (w) w.hidden = !open;
}
export function setManualOpen(open) {
  const w = $('tfManualWrap'), t = $('tfManualToggle');
  if (w) w.hidden = !open;
  if (t) t.textContent = open ? '收起手动录入 ▴' : '手动录入 ▸';
  setNlOpen(!open);                // 互斥：展开手动录入 ⇄ 收起自然语言
  if (open) scrollRecBottom();     // 展开后滚到底，保存按钮可见
}
export function openRecModal(reset = true) {
  const m = $('recModal'); if (!m) return;
  if (reset) {
    resetTradeForm();
    setManualOpen(false);
    const nl = $('tradeNl'); if (nl) nl.value = '';   // 清掉上次的一句话描述
  }
  m.hidden = false;
}
export function closeRecModal() {
  const m = $('recModal'); if (!m) return;
  m.hidden = true;
  const lg = m.querySelector('.modal-lg'); if (lg) lg.style.maxHeight = '';   // 清掉键盘适配的内联高度
  $('tradeHint').hidden = true;
  resetTradeForm();
}
/* 方向 Tab 状态与隐藏 select 同步 */
export function syncTfTypeTabs() {
  const sel = $('tfType');
  if (!sel) return;
  document.querySelectorAll('#tfTypeTabs .wtab').forEach(b => b.classList.toggle('on', b.dataset.t === sel.value));
}
/* 股票联想框：选定即确定代码/名称，市场由代码推断 */
export function setTfStock(code, name) {
  const inp = $('tfStock');
  inp.value = name ? `${code} ${name}` : code;
  inp.dataset.code = code || '';
  inp.dataset.sname = name || '';
}
export function resolveTfStock() {
  const inp = $('tfStock');
  const txt = inp.value.trim();
  let code = inp.dataset.code || '', name = inp.dataset.sname || '';
  let conflict = null;
  if (!(code && txt.startsWith(code)) && txt) {
    const hit = StockDict.resolve(txt);
    if (hit && hit.code) { code = hit.code; name = hit.name || name; conflict = hit.conflict || null; }
    else if (/^\d{5,6}$/.test(txt)) { code = txt; name = ''; }
    else { code = ''; name = ''; }
  }
  if (code && !name) { const hit = StockDict.resolve(code); if (hit && hit.name) name = hit.name; }
  return { code, name, market: code ? inferMarket(code) : 'sh', conflict };
}
export function updateFeePreview() {
  const price = parseFloat($('tfPrice').value), qty = parseInt($('tfQty').value, 10);
  const type = $('tfType').value, market = resolveTfStock().market;
  if (!(price > 0) || !(qty > 0)) { $('feePreview').innerHTML = ''; return; }
  const gross = price * qty;
  const f = calcFees(gross, type, market, resolveTfStock().code);
  const net = type === 'buy' ? gross + f.total : gross - f.total;
  $('feePreview').innerHTML = `
    <span>成交金额 <b>${fmt2(gross)}</b></span>
    <span>佣金 <b>${fmt2(f.commission)}</b></span>
    ${f.stamp ? `<span>印花税 <b>${fmt2(f.stamp)}</b></span>` : ''}
    <span>过户费 <b>${fmt2(f.transfer)}</b></span>
    <span>经手费 <b>${fmt2(f.handling)}</b></span>
    <span>证管费 <b>${fmt2(f.gov)}</b></span>
    <span>${type === 'buy' ? '总投入' : '净到手'} <b>${fmt2(net)}</b></span>`;
  scrollRecBottom();   // 费用预览出现/变化后滚到底，保存按钮可见
}

/* ---------- 自选 ---------- */
/* 买入自动加自选（「默认」组里没有这只票时才加）
   v3.8.83：判重口径从「全局存在即跳过」改为「目标分组内存在才跳过」，
   与手动加自选的同分组去重规则保持一致 —— 否则把票放进别的分组后，
   再买入这只票时就不会往「默认」组里补一条了。 */
export async function autoWatchOnBuy(code, name) {
  try {
    if (!code || S.watchlist.some(w => w.stock_code === code && (w.group_name || '默认') === '默认')) return;
    let anchor = NetQuote.get(code);
    if (!anchor) { try { await refreshQuotes(true); } catch (e) { /* */ } anchor = NetQuote.get(code); }
    const row = { stock_code: code, stock_name: name || code, group_name: '默认', note: '买入自动加入', cur_price: anchor ? anchor.price : null, prev_close: null };
    await store.insert('watchlist', row);
    await store.log('watch', `买入自动加入自选 ${row.stock_name}（${code}）`);
    toast(`已自动加入自选 ${row.stock_name}`);
  } catch (e) { /* 失败不影响交易保存主流程 */ }
}
export function fillFormFromParsed(res) {
  resetTradeForm();
  setManualOpen(true);
  $('tfType').value = res.type;
  syncTfTypeTabs();
  if (res.code) setTfStock(res.code, res.name || '');
  $('tfPrice').value = res.price;
  $('tfQty').value = res.qty;
  if (res.time) {
    const d = new Date(res.time);
    if (!isNaN(d)) {
      const p = n => String(n).padStart(2, '0');
      $('tfTime').value = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
    }
  }
  updateFeePreview();
}
/* v3.8.65 行情悬浮条显隐判定。
   出现条件：① 当前在总览页（其他页没有行情条，出现即误导）；
   ② 大盘卡右上角的原刷新按钮已完全滚出视口上方（rect.bottom < 0）。
   不用 IntersectionObserver 的 isIntersecting：这里要的是「原位入口彻底看不见了」
   这一明确语义，而带阈值/比例的相交判定会让按钮刚露半个在屏顶时悬浮条就冒出来，
   同一功能两处入口同时可见。 */