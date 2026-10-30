/* 问答域：会话 / Agent 工具循环 / 上下文注入 / 历史管理（v0.11.0 自单体拆出） */
import { $, toast, fmt2, fmtP, fmtPct, pnlCls, esc, fmtTime, nowLocalInput, inferMarket, MKT_NAME } from '../shared/utils.js';
import { NetLog, sjTokenHeaders } from '../core/netlog.js';
import { StockDict } from '../core/stockdict.js';
import { DL } from '../core/data-layer.js';
import { emQuote, txQuote } from '../sources/quotes.js';
import { ACCESS_KEY, BACKEND_URL, CLOUD_HOST, RPC_BASE, TABLES, cloudStore, loadAll, localStore, rpc, saveSetting, sessionHooks, setStore, storageHooks, store } from '../storage/gateway.js';
import { S } from '../core/app-state.js';
import { jskillAgentTools, jskillExec } from './jskills.js';
import { cloudLlm } from '../app.js';
import { computeHoldings } from './journal.js';
import { llmComplete, backendLlmStream } from './llm.js';
import { switchSetPane } from './me.js';
import { ModelMgr } from './quotes.js';
import { sjAsrTranscribe, sjCreateMic } from './voice.js';
import { switchView } from '../ui/bind.js';

export const QA_HISTORY_LIMIT = 400;      // 单次拉取的历史记录上限（云端 app_query 无分页）
export const QA_CTX_TRADES = 30;          // 注入上下文时带的近期交易条数

/* v3.9.2 快捷提问示例（数据源，逐字照搬 trade-manager 的 QA_EXAMPLES）。
   空对话时渲染成可点击卡片，点一下把 q 填进输入框；q 里的 {股票} 占位符
   在点击时替换成用户自己的股票（见 qaPickStock）。
   注意：源站这些示例里有一部分依赖它的「交易工具层」（选股 / 回测 / 自动记账）。
   v3.9.7 起工具层已迁到 qa-tools.js（选股 / 行情 / 财务 / 诊断 / 回测 / 风险 / 复盘 /
   K 线相似度），这些示例点下去能真的取到数；只有「自动记账」仍不在范围内。
   放在模块作用域顶部是为了避免 TDZ：qaExamplesHtml 在其之后才定义。 */
export const QA_EXAMPLES = [
  { g: '🎯 智能选股', items: [
    { n: '多因子选股（深度）', q: '筛选A股人形机器人产业链中的公司，需同时满足：PE(TTM) 为正且低于80倍、最新可得ROE高于8%、具备公告或主营业务关联的明确证据。按业务关联证据强度和市值排序，输出完整筛选报告，需列出每只股票的代码、名称、所属环节及各项指标实际数值。随后对排名前3的A股进行综合诊断，分别说明原筛选条件中已被验证、被削弱以及仍待验证的部分。' },
    { n: '低估值高ROE', q: '帮我筛选沪深A股中市盈率低于20倍、ROE高于15%的公司，按ROE从高到低排序，列出前20只的代码、名称、PE、ROE和所属行业。' },
    { n: '板块成分股', q: '列出人形机器人概念的成分股，按总市值从高到低排序，给出前20只的名称、收盘价、涨跌幅、总市值和申万一级行业。' },
    { n: '创业板涨幅榜', q: '列出创业板今天涨幅前 10 的股票，给出代码、名称、涨跌幅和总市值。' },
    { n: '区间+形态选股', q: '在创业板里找近 20 个交易日累计涨幅超过 20%、且近 5 日均量较 20 日均量放量 50% 的股票，按累计涨幅降序给我前 20 只。' },
    { n: '均线形态选股', q: '找出站上 MA60、均线多头排列且不是 ST 的沪深主板股票，按近 20 日涨幅降序前 20 只。' },
    { n: '超跌回撤选股', q: '找出自近 60 日高点回撤超过 30%、市盈率为正的创业板股票，按回撤幅度降序前 20 只。' },
    { n: 'K 线相似度', q: '从我的自选股里找出 K 线形态最像 {股票} 的前 5 只，用近 60 个交易日比对。' },
  ] },
  { g: '🔬 个股诊断', items: [
    { n: '五维诊断（深度）', q: '对{股票}进行全面、深入的五维诊断，覆盖基本面与估值、技术趋势、资金行为、消息事件和机构观点，重点识别不同维度之间的共识、冲突、证据缺口、主要风险及后续验证指标。生成一份包含关键图表和统一综合判断的报告。' },
    { n: '估值贵不贵', q: '{股票}现在估值贵不贵？结合 PE/PB、营收与净利增速、机构目标价给一个明确判断。' },
    { n: '技术位置', q: '{股票}现在的技术面怎么样？支撑位和压力位在哪，这个位置适合买入还是继续观察？' },
    { n: '机构怎么看', q: '机构对{股票}的一致预期如何？评级分布、目标价区间和盈利预测说明了什么？' },
  ] },
  { g: '💼 持仓与风险', items: [
    { n: '持仓体检', q: '帮我做一次持仓体检：逐只给出成本、浮盈亏、仓位占比与风险提示，并指出最该处理的一只。' },
    { n: '组合风险', q: '对我的持仓组合做一次风险分析：集中度、相关性、Beta 与压力测试，并给出再平衡建议。' },
    { n: '该不该加仓', q: '结合我的持仓成本、当前仓位和最近的行情，说清楚我现在该加仓、持有还是减仓，给出触发条件。' },
  ] },
  { g: '🔁 复盘与回测', items: [
    { n: '操作复盘', q: '复盘我最近的操作，找出反复出现的错误与行为偏差，给我 3 条可执行的交易规则。' },
    { n: '策略回测', q: '回测{股票}最近一年的均线策略，看看胜率、盈亏比与最大回撤，并与买入持有做个对比。' },
    { n: '跌买涨卖测试', q: '用一个"跌 5% 买入、涨 5% 卖出"的网格策略回测{股票}最近一年，能赚钱吗？' },
    { n: '回测 + 风控', q: '用均线策略回测{股票}最近一年，叠加 ATR 3 倍跟踪止损和 20% 回撤熔断，看看风控把最大回撤压下去多少。' },
    { n: '策略横截面对比', q: '把唐奇安通道突破策略在我持仓股上跑一遍，按总收益排名看哪只最适合做突破。' },
  ] },
  /* v3.9.2 本组源站叫「记账与日常」，首条「快速记账」依赖源站的自动记账工具
     （maybeRecordFromQa），本项目没迁那层 —— 点了只会得到一段文字而不会真的
     写入交易记录，属于「承诺做不到的事」，故摘除该条与组名里的「记账」。
     仍需 22 条的观感？见 qaEmptyHtml 里 QA_EXAMPLES 的渲染结果（现 21 条）。 */
  { g: '✍️ 日常问答', items: [
    { n: '今日行情', q: '{股票}今天的行情和最新一期财务怎么样？和它的估值水平匹配吗？' },
    { n: '买卖点参考', q: '{股票}最近值得买入吗？如果买，止损位和第一目标位大概放在哪？' },
  ] },
];

/* 会话状态：state.qaAll 为云端全量记录（倒序），其余按会话 id 分桶缓存 */
export const qaState = {
  conversationId: '',
  messages: [],
  all: [],
  msgs: {},          // cid -> 消息数组（切走再切回不丢）
  local: {},         // cid -> {title, at}：已新建但云端还没有占位行的会话
  busyConvs: {},     // cid -> true 正在生成
  controllers: {},   // cid -> AbortController
  stream: {},        // cid -> 已生成的文本
  files: [],         // 待发送附件 [{name, text, image}]
  loaded: false,
  unread: new Set(), // v3.15.0 手机抽屉角标：非当前会话生成完成、还没看过的
};

export function qaNewId() {
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
export function qaMsgsOf(cid) {
  if (!qaState.msgs[cid]) qaState.msgs[cid] = [];
  return qaState.msgs[cid];
}
export function qaAttach(cid) {
  qaState.conversationId = cid;
  qaState.messages = qaMsgsOf(cid);
}

/* ---------- Markdown → HTML（来源同源站 qaMdToHtml，行内标记单独抽出便于复用） ---------- */
export function qaMdInline(s) {
  let t = String(s == null ? '' : s);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return t;
}
/* 极简 Markdown 渲染：标题 / 列表 / 代码块 / 表格 / 引用 / 分隔线 / 段落。
   输入先 esc()，只放开白名单标签，避免模型输出里的 HTML 直接注入。 */
export function qaMdToHtml(src) {
  const lines = esc(String(src == null ? '' : src)).split('\n');
  const out = [];
  let list = null;
  const flush = () => {
    if (list) { out.push('<' + list.tag + '>' + list.items.map(x => '<li>' + x + '</li>').join('') + '</' + list.tag + '>'); list = null; }
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (/^```/.test(t)) {                                    // 代码块
      flush();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) { buf.push(lines[i]); i++; }
      out.push('<pre class="qa-code">' + buf.join('\n') + '</pre>');
      continue;
    }
    if (/^\|.*\|$/.test(t) && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {  // 表格
      flush();
      const cells = s => s.replace(/^\||\|$/g, '').split('|').map(x => qaMdInline(x.trim()));
      const head = cells(t);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) { rows.push(cells(lines[i].trim())); i++; }
      i--;
      out.push('<div class="qa-table-wrap"><table class="qa-table"><thead><tr>' + head.map(x => '<th>' + x + '</th>').join('')
        + '</tr></thead><tbody>' + rows.map(r => '<tr>' + r.map(x => '<td>' + x + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>');
      continue;
    }
    if (/^#{1,6}\s+/.test(t)) { flush(); out.push('<h4 class="qa-h">' + qaMdInline(t.replace(/^#{1,6}\s+/, '')) + '</h4>'); continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flush(); out.push('<hr class="qa-hr">'); continue; }
    let m;
    if ((m = /^[-*+]\s+(.*)$/.exec(t))) {
      if (!list || list.tag !== 'ul') { flush(); list = { tag: 'ul', items: [] }; }
      list.items.push(qaMdInline(m[1]));
      continue;
    }
    if ((m = /^\d+[.)]\s+(.*)$/.exec(t))) {
      if (!list || list.tag !== 'ol') { flush(); list = { tag: 'ol', items: [] }; }
      list.items.push(qaMdInline(m[1]));
      continue;
    }
    if ((m = /^&gt;\s?(.*)$/.exec(t))) { flush(); out.push('<blockquote>' + qaMdInline(m[1]) + '</blockquote>'); continue; }
    if (!t) { flush(); out.push('<div class="qa-gap"></div>'); continue; }
    flush();
    out.push('<p>' + qaMdInline(raw) + '</p>');
  }
  flush();
  return out.join('');
}

/* ---------- 可中止的流式补全 ----------
   现有 llmComplete 不支持 AbortSignal（记一笔不需要中止），这里加一层包装：
   自定义模型走 fetch（原生支持 signal），云端模型走 SDK 的 for await，
   用 signal.aborted 在 chunk 之间跳出。 */
export async function qaLlmStream(messages, { signal, onDelta } = {}) {
  const m = ModelMgr.cur;
  if (!m) throw new Error('尚未选择模型，请到「设置 → AI 模型」选择');
  if (m.custom) {
    let url = m.baseUrl.replace(/\/+$/, '');
    if (!/\/chat\/completions$/.test(url)) url += '/chat/completions';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + m.apiKey },
      body: JSON.stringify({ model: m.model, messages, stream: true }),
      signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error('自定义模型请求失败 HTTP ' + res.status + (t ? '：' + t.slice(0, 200) : ''));
    }
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '', text = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const data = s.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          const d = j.choices && j.choices[0] && j.choices[0].delta;
          if (d && d.content) { text += d.content; if (onDelta) try { onDelta(d.content); } catch (e) { /* */ } }
        } catch (e) { /* 忽略无法解析的行 */ }
      }
    }
    return text;
  }
  /* 云端模型：同源 SDK 优先；本地部署时同源 SDK 不可用（Origin 不是应用域名），
     改走后端代理（v3.21.0）。以前这里直接 `throw 云端模型服务不可用`，
     导致本地部署一进问答就失败 —— 记账解析能走 llmComplete，问答走的是本函数。 */
  if (!cloudLlm) {
    return backendLlmStream(m.id, messages, { signal, onDelta });
  }
  const llm = cloudLlm.llm || cloudLlm;
  let text = '';
  for await (const chunk of llm.chat.completions.create({ model: m.id, messages, stream: true })) {
    if (signal && signal.aborted) break;
    const d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
    if (d && d.content) { text += d.content; if (onDelta) try { onDelta(d.content); } catch (e) { /* */ } }
  }
  return text;
}

/* ============================================================
   v3.11.1 Agentic 工具回路（模型自主决定调用哪个技能）
   ------------------------------------------------------------
   之前：规则路由命中才取数，没命中就让模型裸答 —— 模型没有"自己查"的能力
   （用户截图：「当我的持仓，截至目前的浮动盈亏」→ 只能说"没取到实时行情"）。
   现在：规则路由没命中时，走 OpenAI function calling 循环 —— 把技能清单以
   tools 发给模型，模型返回 tool_calls → 本地真实执行 → 结果回传 → 模型继续，
   最多 4 轮后强制作答。模型不支持 tools（HTTP 400/422）时自动回退纯流式。
   ============================================================ */
/* 工具清单（发给模型 的 tools 参数）。call_skill 是通用口子：一个工具覆盖全部内置技能。 */
export function qaAgentTools() {
  const skillList = (typeof SKILL_CATALOG !== 'undefined')
    ? SKILL_CATALOG.filter(s => s.vendor !== 'mx').map(s => s.id).join('|') : '';
  const tools = [
    { type: 'function', function: {
      name: 'get_holdings_pnl',
      description: '获取用户当前持仓的实时浮动盈亏（逐股 + 合计：数量/成本/现价/市值/盈亏/盈亏%/今日涨跌）。凡用户问持仓赚亏、浮动盈亏、市值，优先用它。',
      parameters: { type: 'object', properties: {} },
    } },
    { type: 'function', function: {
      name: 'get_realtime_quotes',
      description: '批量获取股票实时行情（现价/涨跌幅/成交额）。用户问到具体股票的当前价格时用。',
      parameters: { type: 'object', properties: {
        codes: { type: 'array', items: { type: 'string' }, description: '6 位股票代码数组，如 ["000063","600519"]，最多 30 只' },
      }, required: ['codes'] },
    } },
    { type: 'function', function: {
      name: 'call_skill',
      description: '调用内置数据技能查公开数据（涨停板四池/涨停原因/限售解禁/分红/业绩预告/LPR/可转债/条件选股/板块成分/股东/行情财务/技术分析等）。可用 skill 值：' + skillList,
      parameters: { type: 'object', properties: {
        skill: { type: 'string', description: '技能 id，见描述中的清单' },
        question: { type: 'string', description: '具体化的取数指令（含股票名称/代码与条件，如「中兴通讯最新行情」「今日涨停池」）' },
      }, required: ['question'] },
    } },
  ];
  /* v3.12.0 已安装 SKILL.md 技能包 → 追加 askill 工具（Python 执行于自托管后端） */
  if (typeof skillPacks === 'function') {
    const packs = skillPacks().filter(p => p.enabled !== false && (p.functions || []).length);
    if (packs.length) {
      tools.push({ type: 'function', function: {
        name: 'askill',
        description: '调用已安装的 SKILL.md 技能包函数（Python 数据端点，a-stock-data 等）。'
          + packs.map(p => '技能包「' + p.packName + '」可用函数：' + p.functions.map(f => f.name || f).join('、')).join('；')
          + '。参数 args 按函数签名传（对象键值）。',
        parameters: { type: 'object', properties: {
          pack: { type: 'string', description: '技能包名，如 askill' },
          fn: { type: 'string', description: '要调用的函数名，如 em_zt_pool' },
          args: { type: 'object', description: '函数参数键值对，如 {"date":"20261015"}' },
        }, required: ['pack', 'fn'] },
      } });
    }
  }
  /* v0.12.0 已启用 JS 技能 → 追加 jskill 工具（本地沙箱执行，三环境通用） */
  const jst = jskillAgentTools();
  if (jst.length) tools.push(...jst);
  return tools;
}
/* 技能 id → 具体取数函数（call_skill 的分发表） */
export function qaAgentSkillFn() {
  return {
    'em-screen': q => qaToolScreen(q),
    'em-board': q => qaToolBoard(q),
    'em-holder': q => qaToolHolder(q),
    'em-market': q => qaToolMarketAuto(q),
    'asd-zt': q => qaToolAsdZt(q),
    'asd-thszt': q => qaToolAsdThsZt(q),
    'asd-lockup': q => qaToolAsdLockup(q),
    'asd-dividend': q => qaToolAsdDividend(q),
    'asd-forecast': q => qaToolAsdForecast(q),
    'asd-lpr': () => qaToolAsdLpr(),
    'asd-cb': q => qaToolAsdCb(q),
  };
}
export async function qaAgentExec(name, args, question) {
  if (name === 'get_holdings_pnl') return (await qaToolPnl(question)).block;
  if (name === 'get_realtime_quotes') {
    const codes = (args.codes || []).map(c => String(c).replace(/\D/g, '')).filter(c => /^\d{6}$/.test(c)).slice(0, 30);
    if (!codes.length) throw new Error('codes 必须是 6 位股票代码数组');
    const qs = await emQuotes(codes);
    if (!qs.length) throw new Error('行情接口未返回数据');
    return '实时行情（抓取时点快照）：\n' + qs.map(q =>
      q.code + ' ' + (q.name || '') + '：现价 ' + q.price + '，涨跌幅 ' + q.pct + '%'
      + (q.amount != null ? '，成交额 ' + (q.amount / 1e8).toFixed(2) + ' 亿' : '')).join('\n');
  }
  if (name === 'call_skill') {
    const q = String(args.question || question || '');
    const map = qaAgentSkillFn();
    const fn = map[args.skill];
    if (!fn) throw new Error('未知技能 ' + args.skill + '。可用：' + Object.keys(map).join('、'));
    const r = await fn(q);
    return (r && r.block) || '技能无返回';
  }
  /* v3.12.0 SKILL.md 技能包函数（Python 执行于自托管后端） */
  if (name === 'askill') {
    const out = await skillPackExec('pack-' + (args.pack || 'askill'), args.fn, args.args || {});
    return '技能包函数 ' + args.fn + ' 返回（JSON）：\n' + JSON.stringify(out).slice(0, 6000);
  }
  /* v0.12.0 JS 技能包工具（本地沙箱执行） */
  if (name === 'jskill') return jskillExec(args || {});
  throw new Error('未知工具 ' + name);
}
/* 非流式对话（带 tools），返回 assistant message（含 content / tool_calls） */
export async function qaLlmChat(messages, { tools, signal } = {}) {
  const m = ModelMgr.cur;
  if (!m) throw new Error('尚未选择模型');
  const body = { model: m.custom ? m.model : m.id, messages };
  if (tools && tools.length) body.tools = tools;
  /* v3.17.3 关键修复：本函数原先 stream:false —— 实测平台网关已拒绝一切非流式请求
     （"stream must be true; non-streaming chat completions are not supported"），
     agentic 回路第 1 轮就抛错 → sendQa 静默降级纯文本 baseMsgs：
     ① 带图提问的图片被丢掉（模型说「没收到图片」）；
     ② 所有未命中规则路由的提问，工具回路整体失效、模型再也不调技能。
     改为内部走流式、把增量拼回完整 message（content + tool_calls），对外形状不变。 */
  const mkAccum = () => {
    let content = '';
    const tcs = new Map(), order = [];
    return {
      feed(d) {
        if (d && d.content) content += d.content;
        if (d && d.tool_calls) for (const tc of d.tool_calls) {
          const i = tc.index == null ? 0 : tc.index;
          if (!tcs.has(i)) { tcs.set(i, { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } }); order.push(i); }
          const t = tcs.get(i);
          if (tc.id) t.id = tc.id;
          if (tc.function) {
            if (tc.function.name && !t.function.name) t.function.name = tc.function.name;   // name 通常整段到达
            if (tc.function.arguments) t.function.arguments += tc.function.arguments;       // arguments 逐段增量
          }
        }
      },
      done() {
        const out = { content };
        if (order.length) out.tool_calls = order.sort((a, b) => a - b).map(i => tcs.get(i));
        return out;
      },
    };
  };
  if (m.custom) {
    let url = m.baseUrl.replace(/\/+$/, '');
    if (!/\/chat\/completions$/.test(url)) url += '/chat/completions';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + m.apiKey },
      body: JSON.stringify(Object.assign({ stream: true }, body)),
      signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error('自定义模型请求失败 HTTP ' + res.status + (t ? '：' + t.slice(0, 160) : ''));
    }
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '';
    const acc = mkAccum();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const data = s.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          acc.feed(j.choices && j.choices[0] && j.choices[0].delta);
        } catch (e) { /* 忽略无法解析的行 */ }
      }
    }
    return acc.done();
  }
  /* 云端模型：同源 SDK 优先；本地部署改走后端代理（v3.21.0）。
     代理分支必须用 onDeltaRaw 收「完整 delta」——只给文本会把 tool_calls 丢掉，
     Agent 工具回路就成了摆设（模型永远"没法自己查"，只能凭空回答）。 */
  const acc = mkAccum();
  if (!cloudLlm) {
    await backendLlmStream(m.id, messages, {
      signal,
      onDeltaRaw: acc.feed,
      extraBody: tools && tools.length ? { tools } : null,
    });
    return acc.done();
  }
  const llm = cloudLlm.llm || cloudLlm;
  for await (const chunk of llm.chat.completions.create(Object.assign({ stream: true }, body))) {
    if (signal && signal.aborted) break;
    acc.feed(chunk.choices && chunk.choices[0] && chunk.choices[0].delta);
  }
  return acc.done();
}
export async function qaAgentLoop(baseMsgs, { signal, onNote, onDelta } = {}) {
  /* v3.12.4 轮间 + 工具执行阶段的可中断性（此前取数阶段停止无效） */
  const chkStop = () => { if (signal && signal.aborted) throw Object.assign(new Error('已中断'), { name: 'AbortError' }); };
  const msgs = baseMsgs.slice();
  const lastUser = (() => { for (let i = baseMsgs.length - 1; i >= 0; i--) if (baseMsgs[i].role === 'user') return baseMsgs[i].content; return ''; })();
  for (let round = 0; round < 4; round++) {
    chkStop();
    const msg = await qaLlmChat(msgs, { tools: qaAgentTools(), signal });
    const tcs = msg.tool_calls || [];
    if (!tcs.length) {
      const c = msg.content || '';
      if (c) return c;
      /* 部分小模型 / 云网关会返回"空消息且无 tool_calls"（截图反馈的「本轮未生成回答」）。
         不能把空串当答案返回 → 追问一句，逼模型下一轮给出内容（受轮次上限保护）。 */
      msgs.push({ role: 'user', content: '（系统提示：你上一条回复是空的。请直接回答用户的问题；'
        + '需要数据就调用工具，取不到的如实说明，不要输出空回复。）' });
      continue;
    }
    msgs.push({ role: 'assistant', content: msg.content || '', tool_calls: tcs });
    for (const tc of tcs) {
      chkStop();
      let args = {};
      try { args = JSON.parse((tc.function && tc.function.arguments) || '{}'); } catch (e) { /* */ }
      const fnName = (tc.function && tc.function.name) || '';
      let out;
      try { out = await qaAgentExec(fnName, args, lastUser); }
      catch (e) { out = '工具执行失败：' + (e.message || e) + '。请如实告知用户该数据本次未能取到，不要编造。'; }
      msgs.push({ role: 'tool', tool_call_id: tc.id, content: String(out).slice(0, 8000) });
    }
    if (onNote) try { onNote(tcs.map(t => t.function && t.function.name).join('、')); } catch (e) { /* */ }
  }
  /* 轮次上限 → 强制作答（不带 tools，避免模型继续要调用） */
  msgs.push({ role: 'user', content: '（系统提示：工具调用轮次已达上限，请基于以上工具结果直接回答；取不到的数据如实说明。）' });
  return qaLlmStream(msgs, { signal, onDelta });
}

/* ---------- 问答上下文：把持仓 / 自选 / 近期交易喂给模型 ----------
   v3.9.8 持仓不再自己算，改走 computeHoldings() —— 那是「总览 / 持仓 / 复盘」页面显示的
   **同一个**引擎。旧写法有两条独立缺陷，叠在一起会让问答把「有仓位」说成「空仓」：
     ① 方向字段读的是 `t.action`，而云端 trades 表的真实列名是 `transaction_type`
        （表结构已核对）→ `t.action === 'buy'` 恒 false → **每一笔买入都被当成卖出**
        → 持股量恒 ≤ 0 → 永远输出「无持仓」；
     ② 排序用的是不存在的 `t.trade_date`（真列是 transaction_time）→ 顺序全乱，
        再加上只读 t.price、忽略手续费与 net_amount，成本口径也和页面不一致。
   现在与页面共用一套结果：加权成本、摊薄成本、浮动盈亏都能对上，问答与界面不会再各说各话。 */
export function qaHoldingsSummary() {
  const qm = new Map(S.quotes.map(q => [q.stock_code, q]));
  const out = [];
  for (const h of computeHoldings()) {
    if (!(h.qty > 0)) continue;
    const q = qm.get(h.code);
    const px = q && q.price != null ? Number(q.price) : null;
    const costW = h.costValue / h.qty;      // 加权成本（含手续费）
    const costD = h.dilutedValue / h.qty;   // 摊薄成本（已实现盈亏滚入）
    const pnl = px != null ? h.qty * px - h.costValue : null;
    out.push(`${h.name || h.code}(${h.code})：${h.qty}股，加权成本 ${costW.toFixed(3)}，摊薄成本 ${costD.toFixed(3)}`
      + (px != null ? `，现价 ${px}` : '')
      + (pnl != null ? `，浮动盈亏 ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}元` : ''));
  }
  return out.length ? out.join('；') : '无持仓';
}
export function qaBuildContext() {
  const posStr = qaHoldingsSummary();
  /* v3.9.8 字段名修正：读 transaction_time / transaction_type / note（云端真实列），
     不再是 tm 那套 t.trade_date / t.action / t.comment —— 旧写法让日期列全空、
     方向恒显示「卖出」、备注丢失，模型照着说就成了「最近几笔都是卖出操作」。 */
  const sorted = S.trades.slice().sort((a, b) =>
    String(b.transaction_time || '').localeCompare(String(a.transaction_time || '')));
  const trades = sorted.slice(0, QA_CTX_TRADES).map(t =>
    `${String(t.transaction_time || '').replace('T', ' ').slice(0, 16)} ${t.transaction_type === 'buy' ? '买入' : '卖出'} `
    + `${t.stock_name || t.stock_code}(${t.stock_code}) ${t.quantity}股 @${t.price}`
    + (t.note ? `（${t.note}）` : '')).join('\n') || '无';
  const watch = S.watchlist.map(w => `${w.stock_name || w.stock_code}${w.note ? `（${w.note}）` : ''}`).join('、') || '无';
  return `【用户当前持仓】${posStr}\n【自选股】${watch}\n【近期交易记录（新→旧）】\n${trades}\n`
    + '【说明】以上是用户在本应用里记录的数据，可能不是最新行情。涉及「今天涨跌/当前价格」这类'
    + '实时性问题时，请说明你看到的是记录值、可能存在延迟，不要编造具体价格与财务数字。';
}
export function qaSysPrompt() {
  return '你是「操作日志」里的智能助手，帮用户复盘交易、解答疑问、聊聊市场。'
    + '回答要简洁、口语化、有条理；涉及数字时优先引用下面给出的用户数据。'
    /* v3.9.8 反「念小抄」约束。用户问「持仓多少」时，模型把【用户当前持仓】【自选股】
       【近期交易记录】三块依次复述一遍，其中「空仓」在相邻三句里说了三遍、自选名单出现两次
       —— 看着信息很全，实际是冗余。根因是提示词只说"优先引用下面的数据"，等于鼓励它逐条倒出来。
       这里明确：下面的数据是备查材料，只回答被问到的部分，同一结论不重复。 */
    + '**只回答用户实际问到的内容**：下面给你的用户数据是「备查材料」，不要逐项复述；'
    + '同一结论只讲一次，不要换着措辞反复强调（例如「目前空仓」不要在三句话里说三遍）。'
    + '问题很短、只是要一个事实（持仓多少 / 有哪些自选 / 最近交易）时，一两句话直接给答案，'
    + '不要展开分析，也不要主动补充他没问的部分。'
    /* v3.9.7 工具层上线后：模型能拿到真实抓取的行情/财务/筛选结果，必须优先采信，
       而不是拿自己的记忆数字去覆盖，也不再需要为"实时性问题"打延迟免责声明。 */
    + '如果下面出现了【工具计算结果】，那是本应用刚刚实时抓取到的权威数据 —— 涉及这些'
    + '标的的价格、涨跌、估值、财务、筛选名单时，必须严格使用其中的数字，禁止用你自己的'
    + '记忆改写或补充；工具结果里标注为「本次未取到」的部分要如实说明缺失，不要用推测填补。'
    + '没有【工具计算结果】时，才按你自身知识回答，并说明可能不是最新。'
    + '可以正常使用 Markdown（标题、列表、表格、加粗、代码），但不要输出 HTML。\n\n';
}

/* ---------- 渲染：消息区 ---------- */
/* v3.9.2 空对话态由「一行提示」升级为「分组快捷提问卡片」（照搬 trade-manager）。
   旧版只有一段 qa-empty-tip 纯文本，用户得自己组织问题；现在把常用问法摆出来，
   点一下即填入输入框，降低上手成本。 */
export function qaPickStock() {
  /* {股票} 的默认取值：优先持仓 → 自选 → 交易过的 → 兜底示例。
     v3.9.8 改走 computeHoldings()（与「总览 / 持仓」页同一份口径）。
     旧写法自己遍历 S.trades 并读 t.action —— 该字段在云端 trades 表里根本不存在
     （真实列名是 transaction_type），`t.action === 'buy'` 恒 false → 持股量恒为负
     → 永远认为「没有持仓」，于是 {股票} 一直落到自选第一只，而不是真持仓第一只。 */
  const qm = new Map(S.quotes.map(q => [q.stock_code, q]));
  const holds = computeHoldings().filter(h => h.qty > 0);
  if (holds.length) {
    const mv = h => { const q = qm.get(h.code); return q && q.price != null ? h.qty * Number(q.price) : 0; };
    holds.sort((a, b) => mv(b) - mv(a));      // 按当前市值从大到小，取最重的一只
    return holds[0].name || holds[0].code;
  }
  if (S.watchlist.length) return S.watchlist[0].stock_name || S.watchlist[0].stock_code;
  if (S.trades.length) return S.trades[0].stock_name || S.trades[0].stock_code;
  return '贵州茅台';
}
export function qaEmptyHtml() {
  const intro = '<div class="qa-ex-intro">👋 我是你的操作日志，能结合你的持仓、自选与交易记录回答问题。'
    + '<br>下面是一些常用问法，点一下即可填入输入框（<b>{股票}</b> 已自动替换为你的股票，可自行修改）——</div>';
  const groups = QA_EXAMPLES.map(g =>
    '<div class="qa-ex-group"><div class="qa-ex-title">' + esc(g.g) + '</div><div class="qa-ex-grid">'
    + g.items.map(x => '<button type="button" class="qa-ex-card" data-q="' + esc(x.q) + '"><b>' + esc(x.n) + '</b><span>'
      + esc(x.q.replace(/\{股票\}/g, '某股').slice(0, 46)) + '…</span></button>').join('')
    + '</div></div>').join('');
  return '<div class="qa-examples">' + intro + groups
    + '<div class="qa-ex-foot">也可以直接聊别的，或「上传文件」（txt / csv / md / json）让我帮你看看。</div>'
    + '</div>';
}
/* 点击示例卡片 → 填入输入框（{股票} 就地替换）并聚焦，光标落到末尾 */
export function qaUseExample(q) {
  const input = $('qaInput');
  if (!input || !q) return;
  const text = String(q).replace(/\{股票\}/g, qaPickStock());
  input.value = text;
  qaSyncSendState();
  input.focus();
  try { input.setSelectionRange(text.length, text.length); } catch (e) { /* 忽略 */ }
}
/* 示例卡片是随 renderQaMessages 重建的，故用事件委托绑在 #qaMessages 上，
   只绑一次（dataset 打标防重复绑定，登录多次不叠加监听）。 */
export function bindQaExamples() {
  const box = $('qaMessages');
  if (!box || box.dataset.exBound) return;
  box.dataset.exBound = '1';
  box.addEventListener('click', e => {
    const btn = e.target.closest('.qa-ex-card');
    if (!btn) return;
    qaUseExample(btn.dataset.q);
  });
  /* v3.14.0 「＋」弹出菜单：文件 / 技能搜索列表（示例问题恢复独立 💡 按钮） */
  const plus = $('qaPlusBtn'), menu = $('qaPlusMenu'), skMenu = $('qaSkillMenu');
  if (!plus || !menu || plus.dataset.plusBound) return;
  plus.dataset.plusBound = '1';
  const closeAll = () => { menu.hidden = true; skMenu.hidden = true; };
  plus.addEventListener('click', e => {
    e.stopPropagation();
    const open = !menu.hidden;
    closeAll();
    if (open) return;
    menu.hidden = false;
  });
  menu.addEventListener('click', e => {
    const item = e.target.closest('.qa-plus-item');
    if (!item) return;
    e.stopPropagation();   /* v3.14.0 关键修复：阻止冒泡到 document 的「点外关闭」监听——
                              否则刚打开的技能面板会被同一次点击立刻关掉（面板闪一下即逝） */
    const act = item.dataset.act;
    if (act === 'attach') { closeAll(); $('qaFileInput').click(); }
    else if (act === 'skills') { menu.hidden = true; skMenu.hidden = false; $('qaSkillSearch').value = ''; renderQaSkillPick(''); setTimeout(() => $('qaSkillSearch').focus(), 30); }
  });
  skMenu.addEventListener('click', e => {
    const item = e.target.closest('.qa-plus-item');
    if (item) {
      const act = item.dataset.act;
      if (act === 'skillLocal' || act === 'skillManage') {
        closeAll();
        switchView('me'); switchSetPane('skill');
      }
      return;
    }
    const toggle = e.target.closest('.sk-toggle');
    if (toggle) {
      e.stopPropagation();
      const id = toggle.dataset.sid;
      const s = skillById(id);
      const on = !(s && s.enabled === false);
      skillSetEnabled(id, !on);          // 现在是开 → 点了变关
      renderQaSkillPick($('qaSkillSearch').value);
      return;
    }
    const row = e.target.closest('.qa-skill-row');
    if (row) {
      qaUseExample(row.dataset.q || row.dataset.name || '');
      closeAll();
    }
  });
  $('qaSkillSearch').addEventListener('input', e => renderQaSkillPick(e.target.value));
  /* v3.14.0 恢复独立 💡 按钮（用户要求示例问题独立出来，回到 v3.12.7 逻辑） */
  const exBtn = $('qaExBtn'), panel = $('qaExPanel');
  if (exBtn && panel && !exBtn.dataset.exBound) {
    exBtn.dataset.exBound = '1';
    exBtn.addEventListener('click', e => {
      e.stopPropagation();
      closeAll();
      if (!panel.innerHTML) panel.innerHTML = '<div class="qa-ex-head"><b>💡 示例问题</b><button type="button" class="qa-ex-close" title="收起">✕</button></div>' + qaEmptyHtml();
      panel.hidden = !panel.hidden;
    });
    panel.addEventListener('click', e => {
      if (e.target.closest('.qa-ex-close')) { panel.hidden = true; return; }
      const btn = e.target.closest('.qa-ex-card');
      if (!btn) return;
      qaUseExample(btn.dataset.q);
      panel.hidden = true;
    });
  }
  document.addEventListener('click', e => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== plus && !plus.contains(e.target)) menu.hidden = true;
    if (!skMenu.hidden && !skMenu.contains(e.target) && e.target !== plus && !plus.contains(e.target)) skMenu.hidden = true;
    /* 示例面板：点外部收起（面板内的卡片/关闭按钮不触发） */
    const p = $('qaExPanel');
    if (p && !p.hidden && !p.contains(e.target) && e.target !== exBtn && !exBtn.contains(e.target)) p.hidden = true;
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAll(); });
  /* 示例面板内：✕ 收起 / 点卡片填入并收起（v3.13.0 重构时丢了面板的点击绑定，这里补回） */
  const exPanel = $('qaExPanel');
  exPanel.addEventListener('click', e => {
    if (e.target.closest('.qa-ex-close')) { exPanel.hidden = true; return; }
    const btn = e.target.closest('.qa-ex-card');
    if (!btn) return;
    qaUseExample(btn.dataset.q);
    exPanel.hidden = true;
  });
}
/* 技能选择列表：搜索过滤 + 点击填触发问句 + 右侧启停开关 */
export function renderQaSkillPick(filter) {
  const box = $('qaSkillPick');
  if (!box) return;
  const f = String(filter || '').trim().toLowerCase();
  const list = skillListAll().filter(s => !f
    || (s.name || '').toLowerCase().indexOf(f) >= 0
    || (s.desc || '').toLowerCase().indexOf(f) >= 0
    || (s.id || '').toLowerCase().indexOf(f) >= 0);
  if (!list.length) { box.innerHTML = '<p class="hint" style="padding:8px 10px">没有匹配的技能</p>'; return; }
  box.innerHTML = list.map(s => {
    const on = s.enabled !== false && s.installed;
    const sample = s.isUser && s.keywords && s.keywords.length ? s.keywords[0]
      : (s.id === 'pnl' ? '持仓的票分析下' : (s.name || s.id));
    return `<button type="button" class="qa-skill-row${on ? '' : ' sk-off'}" data-q="${esc(sample)}" data-name="${esc(s.name)}">`
      + `<span class="sk-ic">${esc(s.icon || '🧩')}</span><span class="sk-name">${esc(s.name)}</span>`
      + `<span class="sk-desc">${esc((s.desc || '').slice(0, 40))}</span>`
      + `<span class="sk-toggle${on ? ' on' : ''}" data-sid="${esc(s.id)}" title="点击${on ? '停用' : '启用'}">${on ? '启用中' : '已停用'}</span></button>`;
  }).join('');
}
/* v3.17.1 修复：v3.13.3 图片提问时把用户消息 content 存成了多模态数组
   （text + image_url），但渲染层还在当纯字符串 esc(m.content) → 气泡显示
   「[object Object],[object Object]」，renderQaJump 的 m.content.split 更是直接
   TypeError。这里统一出口：文本取 text 段拼接，图片段转成 <img> 缩略图。 */
export function qaUserMsgParts(m) {
  if (!Array.isArray(m.content)) return { text: String(m.content == null ? '' : m.content), imgs: [] };
  return {
    text: m.content.filter(p => p.type === 'text').map(p => p.text).join('\n'),
    imgs: m.content.filter(p => p.type === 'image_url' && p.image_url && p.image_url.url)
      .map(p => p.image_url.url),
  };
}
export function qaUserMsgText(m) {
  return qaUserMsgParts(m).text;
}
export function qaUserMsgHtml(m) {
  const { text, imgs } = qaUserMsgParts(m);
  const imgsHtml = imgs.map(u =>
    /* v3.17.1 不用 <a target=_blank>：浏览器禁止顶层导航到 data: URL，点了没反应 */
    `<img class="qa-user-img" src="${esc(u)}" alt="附件图片">`
  ).join('');
  return esc(text) + (imgsHtml ? `<div class="qa-user-imgs">${imgsHtml}</div>` : '');
}
export function renderQaMessages() {
  const box = $('qaMessages');
  if (!box) return;
  const cid = qaState.conversationId;
  const busy = !!qaState.busyConvs[cid];
  if (!qaState.messages.length && !busy) { box.innerHTML = qaEmptyHtml(); return; }
  let uidx = 0;
  let html = qaState.messages.map(m => {
    /* v3.9.7 工具结果便签：qa-tools.js 的 qaRunTools 会往消息流里塞一条 role:'tool' 的
       记录（icon/title/lines/html/chart/skills），它不是对话内容而是「本轮取到了哪些数据」
       的凭证，所以单独走 toolNoteHtml 渲染，并用 .msg.note 的居中浅绿气泡样式区分开。 */
    if (m.role === 'tool') return `<div class="msg note">${toolNoteHtml(m)}</div>`;
    if (m.role === 'assistant') return `<div class="msg assistant">${qaMdToHtml(m.content)}</div>`;
    /* v3.17.1 用户气泡走 qaUserMsgHtml：数组 content 正确显示文本+图片缩略图 */
    if (m.role === 'user') { uidx += 1; return `<div class="msg ${m.role}" data-uidx="${uidx - 1}">${qaUserMsgHtml(m)}</div>`; }
    return `<div class="msg ${m.role}">${esc(m.content)}</div>`;
  }).join('');
  /* 正在生成的会话补一个流式气泡：切走再切回来，已生成的部分接着显示
     （内容存在 qaState.stream，DOM 用固定 id 定位，不依赖旧元素引用） */
  if (busy) {
    const s = qaState.stream[cid] || '';
    html += `<div class="msg assistant" id="qaStream-${esc(cid)}">${s ? qaMdToHtml(s) : '思考中…'}</div>`;
  }
  box.innerHTML = html;
  box.scrollTop = box.scrollHeight;
  renderQaJump();
}

/* ---------- v3.12.1 右侧「本会话提问」快速导航（类似 WorkBuddy 的历史问题列表） ---------- */
export function qaJumpCollapsed() {
  try { return localStorage.getItem('sj_qa_jump') === '0'; } catch (e) { return false; }
}
export function renderQaJump() {
  const list = $('qaJumpList'), panel = $('qaJumpPanel'), layout = document.querySelector('.qa-layout');
  if (!list) return;
  const collapsed = qaJumpCollapsed();
  if (layout) layout.classList.toggle('no-jump', collapsed);
  if (panel) panel.classList.toggle('collapsed', collapsed);
  const btn = $('qaJumpToggle');
  if (btn) btn.textContent = collapsed ? '«' : '»';
  const qs = (qaState.messages || []).filter(m => m.role === 'user');
  const shown = qs.slice(-80);
  list.innerHTML = shown.length
    ? shown.map((m, i) => {
        const idx = qs.length - shown.length + i;
        /* v3.17.1 数组 content（图片提问）不能直接 split —— 走统一文本出口 */
        const t = qaUserMsgText(m).split('\n')[0].replace(/📎.*$/, '').trim() || '（附件提问）';
        return `<button type="button" class="qa-jump-item" data-uidx="${idx}" title="${esc(t)}">${esc(t.length > 42 ? t.slice(0, 42) + '…' : t)}</button>`;
      }).join('')
      : '<div class="qa-jump-empty">提问之后，这里会按顺序列出本会话的问题，点一下跳到对应回答。</div>';
}
export function bindQaJump() {
  const list = $('qaJumpList'), toggle = $('qaJumpToggle');
  /* v3.21.4 ≤1080px 时右栏是「滑出面板」而不是第三个栅格列（见 style.css），
     开关语义随之变化：宽屏是「折叠后不留位置」，窄屏是「默认关、点开覆盖」。
     原来窄屏直接 display:none，这块信息在 1024/1366 笔记本上根本打不开。 */
  const layout = document.querySelector('.qa-layout');
  const narrow = () => window.matchMedia('(max-width: 1080px)').matches;
  const setJumpOpen = v => { if (layout) layout.classList.toggle('jump-open', !!v); };
  const jumpOpen = () => !!(layout && layout.classList.contains('jump-open'));

  if (list) list.addEventListener('click', e => {
    const b = e.target.closest('.qa-jump-item[data-uidx]');
    if (!b) return;
    const el = document.querySelector(`#qaMessages .msg.user[data-uidx="${b.dataset.uidx}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1200);
    if (narrow()) setJumpOpen(false);          /* 窄屏选完就收起，别挡着正文 */
  });
  if (toggle) toggle.addEventListener('click', () => {
    if (narrow()) { setJumpOpen(false); return; }
    try { localStorage.setItem('sj_qa_jump', qaJumpCollapsed() ? '1' : '0'); } catch (e) { /* */ }
    renderQaJump();
  });
  /* 窄屏专用入口：.qa-mtop 里的「提问」按钮 + 遮罩 */
  const btnM = $('qaJumpBtn'), mask = $('qaJumpMask');
  if (btnM) btnM.addEventListener('click', () => setJumpOpen(!jumpOpen()));
  if (mask) mask.addEventListener('click', () => setJumpOpen(false));
  /* 拉大窗口时把窄屏的滑出状态清掉，否则面板会以 fixed 定位残留在屏幕上 */
  window.addEventListener('resize', () => { if (!narrow() && jumpOpen()) setJumpOpen(false); });
  renderQaJump();
}

/* ---------- 渲染：左侧历史列表 ---------- */
/* v3.15.0 手机抽屉未读角标（顶层：sendQa 与抽屉开关都要调） */
export function qaRenderDrawerBadge() {
  const b = $('qaDrawerBadge');
  if (!b) return;
  const n = qaState.unread ? qaState.unread.size : 0;
  b.hidden = !n;
  b.textContent = n;
}
export function renderQaHistory() {
  const list = $('qaHistoryList');
  if (!list) return;
  const kwEl = $('qaSearch');
  const kw = kwEl ? kwEl.value.trim().toLowerCase() : '';
  let rows = qaState.all;
  if (kw) rows = rows.filter(r => ((r.question || '') + (r.answer || '')).toLowerCase().includes(kw));
  /* 云端聚合：每个会话取最新一条问题做标题（all 已按 id 倒序 = 插入倒序） */
  const convs = [];
  const seen = new Set();
  for (const r of rows) {
    const cid = r.conversation_id;
    if (!cid || seen.has(cid)) continue;
    seen.add(cid);
    convs.push({ id: cid, title: String(r.question || '').replace(/^📎.*$/m, '').slice(0, 30) || '新对话' });
  }
  /* 本地登记的会话（刚点「新对话」或占位行还在路上）顶到最前，
     这样左侧列表不用等落库往返就能看到 */
  const extra = Object.keys(qaState.local)
    .filter(id => !seen.has(id))
    .map(id => ({ id, title: qaState.local[id].title, at: qaState.local[id].at || 0 }))
    .filter(c => !kw || String(c.title).toLowerCase().includes(kw))
    .sort((a, b) => b.at - a.at)
    .map(c => ({ id: c.id, title: c.title }));
  const finalList = extra.concat(convs);
  const html = finalList.length
    ? finalList.map(c => `<div class="qa-hist-item${c.id === qaState.conversationId ? ' active' : ''}">`
        + `<span class="qa-hist-main" data-qa-open="${esc(c.id)}">💬 ${esc(c.title)}</span>`
        + `<span class="qa-hist-del" title="删除该会话" data-qa-del="${esc(c.id)}">✕</span></div>`).join('')
    : '<div class="qa-empty-tip" style="font-size:12.5px">暂无历史问答</div>';
  list.innerHTML = html;
  /* v3.15.0 手机抽屉里的会话列表同步渲染（桌面隐藏，≤720px 显示） */
  const listM = $('qaHistoryListM');
  if (listM) listM.innerHTML = html;
  qaRenderDrawerBadge();
}

/* ---------- 附件 ---------- */
export function renderQaChips() {
  const box = $('qaAttachChips');
  if (!box) return;
  const fs = qaState.files;
  box.hidden = !fs.length;
  /* v3.13.3 图片附件显示缩略图（48px），文本附件显示字数 */
  box.innerHTML = fs.map((f, i) =>
    `<span class="qa-attach-chip">${f.image ? `<img class="qa-chip-img" src="${f.image}" alt="">` : ''}`
    + `<b>${esc(f.name)}</b><span>${f.image ? '图片' : (f.text ? Math.round(f.text.length / 100) / 10 + 'k 字' : '')}</span>`
    + `<button type="button" data-qa-rm="${i}" title="移除">✕</button></span>`).join('');
}
export async function qaAddFile(f) {
  if (qaState.files.length >= 5) { toast('最多同时带 5 个附件', 'warn'); return; }
  const isImg = /^image\//.test(f.type);
  if (isImg) {
    const raw = await new Promise(res => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => res('');
      fr.readAsDataURL(f);
    });
    if (!raw) { toast('图片读取失败', 'warn'); return; }
    /* v3.13.3 压缩到 ≤1024px 再发模型（base64 太大会拖垮请求） */
    const dataUrl = await new Promise(res => {
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, 1024 / Math.max(img.width, img.height));
          if (scale >= 1) return res(raw);
          const cv = document.createElement('canvas');
          cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
          cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
          res(cv.toDataURL('image/jpeg', 0.85));
        } catch (e) { res(raw); }
      };
      img.onerror = () => res(raw);
      img.src = raw;
    });
    qaState.files.push({ name: f.name, image: dataUrl });
  } else {
    if (f.size > 512 * 1024) { toast('文件过大（限 500KB）', 'warn'); return; }
    const text = await f.text().catch(() => '');
    if (!text) { toast('文件读取失败', 'warn'); return; }
    qaState.files.push({ name: f.name, text });
  }
  renderQaChips();
}

/* ---------- 发送 / 中止 ---------- */
export function qaSyncSendState() {
  const btn = $('qaSendBtn'), stop = $('qaStopBtn'), inp = $('qaInput');
  if (!btn) return;
  const busy = !!qaState.busyConvs[qaState.conversationId];
  const has = !!(inp && inp.value.trim()) || qaState.files.length > 0;
  btn.disabled = busy || !has;
  if (stop) stop.hidden = !busy;
  /* v3.15.0 「当前模型」行按需求删除：qa-src-bar 已从页面移除，这里不再填充 */
}
export function qaLocalSet(cid, title) {
  /* 顺手清掉之前建过、但一直没用过的空会话，免得「新对话」项越堆越多 */
  Object.keys(qaState.local).forEach(id => {
    if (id === cid) return;
    const it = qaState.local[id];
    if (it && it.title === '新对话'
      && !(qaState.msgs[id] || []).length
      && !qaState.busyConvs[id]
      && !qaState.all.some(r => r.conversation_id === id)) delete qaState.local[id];
  });
  const cur = qaState.local[cid];
  const t = title === undefined ? '' : String(title || '').trim();
  qaState.local[cid] = {
    title: (t || (cur && cur.title) || '新对话').slice(0, 30),
    at: cur ? cur.at : Date.now(),
  };
}

export async function sendQa() {
  /* v3.17.2 防重发守卫：当前会话还在生成时不允许再发。按钮在 qaSyncSendState
     里已禁用，但 Enter 键是直接调 sendQa()、绕过 disabled —— 旧代码能在上一个
     问题没答完时再发一条，两条回答会交错写进同一个会话流。按钮和键盘统一在
     这里拦下。 */
  if (qaState.busyConvs && qaState.busyConvs[qaState.conversationId]) {
    toast('上一个问题还在回答中，请等它完成，或点 ■ 停止后再发', 'warn');
    return;
  }
  const input = $('qaInput');
  const question = input.value.trim();
  const files = qaState.files || [];
  if (!question && !files.length) return;
  /* v3.9.8 记录类问题（持仓 / 自选 / 交易记录）本地直答：答案全在本机数据里，
     不需要模型也不需要联网。放在最前面有两个作用 ——
       ① 彻底避开模型把【持仓】【自选】【交易记录】三块小抄各念一遍的啰嗦
          （用户反馈：问「持仓多少」得到三句「目前处于空仓状态」）；
       ② 没配 AI 模型时也照样能查持仓（下面的模型校验对它放行）。
     带附件的提问一律不走本地直答 —— 附件内容可能重新定义问题，交给模型更稳。 */
  const localAns = files.length ? '' : qaLocalAnswer(question);
  if (!localAns && !ModelMgr.cur) { toast('请先到「设置 → AI 模型」选择一个模型', 'warn'); return; }
  /* 会话快照：本次生成全程绑定 convId。中途切走会话也不中断，回答会照常入库，
     切回来就能看到；只有「当前视图仍是本会话」时才回写界面。 */
  const convId = qaState.conversationId;
  qaState.messages = qaMsgsOf(convId);
  const myMsgs = qaState.messages;
  input.value = '';
  /* 附件内容拼进问题文本，展示层只带附件名单 */
  const attachNote = files.length ? '\n📎 附件：' + files.map(f => f.name).join('、') : '';
  let fullQuestion = question;
  for (const f of files) if (f.text) fullQuestion += `\n\n【附件：${f.name}】\n${f.text.slice(0, 8000)}`;
  qaState.files = [];
  renderQaChips();
  qaState.busyConvs[convId] = true;
  const controller = new AbortController();
  qaState.controllers[convId] = controller;
  /* v3.12.4 关键修复：signal 此前从未定义（v3.11.1 回路重构遗漏）——停止按钮 abort
     了没人监听的控制器，工具取数阶段完全停不了；且取数完成后走流式必抛
     ReferenceError → 全部显示「回答失败」。现在正确接线。 */
  const signal = controller.signal;
  /* v3.13.3 图片附件真正发给模型：content 用 multipart 数组（text + image_url），
     模型/网关不支持时顶层 catch 会自动降级为纯文本重试 */
  const imgFiles = files.filter(f => f.image);
  const asTextContent = m => Array.isArray(m.content)
    ? m.content.filter(p => p.type === 'text').map(p => p.text).join('\n') : m.content;
  myMsgs.push({
    role: 'user',
    content: imgFiles.length
      ? [{ type: 'text', text: fullQuestion }, ...imgFiles.map(f => ({ type: 'image_url', image_url: { url: f.image } }))]
      : question + attachNote,
  });
  qaState.stream[convId] = '';
  qaLocalSet(convId, question || (files.length ? '附件提问' : ''));
  renderQaMessages();
  renderQaHistory();
  qaSyncSendState();

  /* 落库占位：后台并行写，不阻塞提问；生成结束时要拿它的 id 做替换，所以留一个 promise */
  const phPromise = (async () => {
    try {
      const ph = await store.insert('qa_history', {
        conversation_id: convId, question: question + attachNote, answer: '',
      });
      const id = (ph && ph.id) || 0;
      await qaReloadAll();
      if (qaState.all.some(x => x.conversation_id === convId)) delete qaState.local[convId];
      renderQaHistory();
      return id;
    } catch (e) { return 0; }
  })();

  const box = $('qaMessages');
  const streamEl = () => document.getElementById('qaStream-' + convId);
  const onScreen = () => qaState.conversationId === convId;
  const holder = streamEl() || (() => {
    const d = document.createElement('div');
    d.className = 'msg assistant';
    d.id = 'qaStream-' + convId;
    d.textContent = '思考中…';
    if (box) box.appendChild(d);
    return d;
  })();
  if (box) box.scrollTop = box.scrollHeight;

  let answer = '', streamed = '', lastPaint = 0;
  /* 长回答首字较慢时给个明确提示，避免「卡死」观感 */
  const slowTip = setTimeout(() => {
    if (streamed) return;
    const h = streamEl();
    if (h) h.textContent = '正在生成较长内容，请稍候…（可点右侧 ■ 中断）';
  }, 20000);

  try {
    if (localAns) {
      /* v3.9.8 本地直答分支：直接落字，不跑工具、不请求模型。同步完成，
         holder 上那句「思考中…」在同一帧内就被替换掉，用户看不到中间态。 */
      answer = localAns;
      qaState.stream[convId] = localAns;
      const h0 = streamEl();
      if (h0) h0.innerHTML = qaMdToHtml(localAns);
      if (box) box.scrollTop = box.scrollHeight;
    } else {
    /* v3.9.7 先跑工具取数。命中意图（选股 / 行情 / 财务 / 诊断 / 回测 / 风险 / 复盘 / K线相似度）时，
       qaRunTools 会真实抓取公开数据、往消息流插一张结果便签，并返回一段【工具计算结果】文本；
       把它接到 system 末尾，模型就必须引用其中的真实数字，而不是凭记忆编造。
       工具层任何失败都不影响正常问答（异常吞掉，退化为原来的纯上下文问答）。 */
    let toolBlock = '';
    try { toolBlock = await qaRunTools(question, box, holder, signal); } catch (e) {
      /* 中断向上传递（不能当「工具失败」吞掉继续问模型） */
      if (e && e.name === 'AbortError') throw e;
      toolBlock = '';
    }
    const sys = qaSysPrompt() + qaBuildContext() + (toolBlock ? '\n\n' + toolBlock : '');
    /* v3.17.1 历史里的图片消息（数组 content）统一抽出纯文本：baseMsgs 走的是
       非多模态请求，原样塞数组会让不支持多模态的模型报错或看不懂 */
    const history = myMsgs
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .slice(-9, -1).map(m => ({ role: m.role, content: Array.isArray(m.content) ? qaUserMsgText(m) : m.content }));
    const baseMsgs = [{ role: 'system', content: sys }, ...history, { role: 'user', content: fullQuestion }];
    /* v3.13.3 带图版消息（多模态模型直接支持；不支持时顶层 catch 降级重试纯文本） */
    const withImgMsgs = imgFiles.length ? [{ role: 'system', content: sys }, ...history, {
      role: 'user',
      content: [{ type: 'text', text: fullQuestion }, ...imgFiles.map(f => ({ type: 'image_url', image_url: { url: f.image } }))],
    }] : baseMsgs;
    if (toolBlock) {
      /* 规则路由命中 → 原单轮流式（快路径，不受模型能力影响） */
      const onDeltaRr = (d) => {
        streamed += d;
        qaState.stream[convId] = streamed;
        const h = streamEl();
        if (!h) return;
        const now = Date.now();
        if (!lastPaint || now - lastPaint > 90) {
          lastPaint = now;
          h.innerHTML = qaMdToHtml(streamed);
          if (box) box.scrollTop = box.scrollHeight;
        }
      };
      answer = await qaLlmStream(baseMsgs, { signal, onDelta: onDeltaRr });
      /* v3.17.6 模型偶发返回空流（网关/小模型抽风，一次调用零 token）——此时数据其实
         已经取到了（上方便签就是），缺的只是模型总结。旧写法直接落「（本轮未生成回答）」，
         用户看起来像「工具答完就没模型的事了」。现在：空流先原样重试一次（流式网关
         偶发抽风重试即好）；仍空则给出诚实兜底文案并引导重发，不再假装「没有回答」。 */
      if (!answer) {
        streamed = '';
        answer = await qaLlmStream(baseMsgs, { signal, onDelta: onDeltaRr });
        answer = answer || streamed;
      }
      if (!answer) answer = '⚠️ 数据已取到（见上方结果表），但模型这次没有生成文字总结。请点此重发或换个问法再试一次。';
    } else {
      /* v3.11.1 规则路由没命中 → Agentic 回路：模型自己决定调用哪个技能，
         本地真实执行后回传，最多 4 轮，再流式/直接作答。
         模型不支持 function calling（HTTP 400/422）→ 自动回退纯上下文流式。 */
      const onDeltaAg = (d) => {
        streamed += d;
        qaState.stream[convId] = streamed;
        const h = streamEl();
        if (!h) return;
        const now = Date.now();
        if (!lastPaint || now - lastPaint > 90) {
          lastPaint = now;
          h.innerHTML = qaMdToHtml(streamed);
          if (box) box.scrollTop = box.scrollHeight;
        }
      };
      try {
        answer = await qaAgentLoop(withImgMsgs, {
          signal,
          onDelta: onDeltaAg,
          onNote: nm => {
            const h = streamEl();
            if (h && onScreen()) {
              h.innerHTML = '<span class="hint">🔧 模型自主调用技能：' + esc(nm) + ' …</span>';
              if (box) box.scrollTop = box.scrollHeight;
            }
          },
        });
        /* 模型坚持回空串 → 不带 tools 的纯流式兜底（保证用户总能拿到一句回复） */
        if (!answer) {
          answer = await qaLlmStream(baseMsgs, { signal, onDelta: onDeltaAg });
          answer = answer || streamed;
        }
        /* v3.17.6 仍空 → 同规则路由分支：诚实告知数据已取到、只缺总结，引导重发 */
        if (!answer) answer = '⚠️ 数据已取到（见上方结果表），但模型这次没有生成文字总结。请点此重发或换个问法再试一次。';
      } catch (eAg) {
        if (eAg && eAg.name === 'AbortError') throw eAg;
        NetLog.push('llm', 'agentic 回路回退', false, 0, eAg.message || String(eAg));
        answer = await qaLlmStream(baseMsgs, { signal, onDelta: onDeltaAg });
        answer = answer || streamed;
      }
    }
    const h = streamEl();
    if (h) h.innerHTML = qaMdToHtml(answer);
    }
  } catch (e) {
    if (e && e.name === 'AbortError') {
      answer = streamed;
      const h = streamEl();
      if (h) h.innerHTML = qaMdToHtml(streamed || '（已停止生成）');
    } else if (imgFiles.length) {
      /* v3.13.3 图片请求被模型/网关拒绝 → 自动降级纯文本重试一次 */
      try {
        const h0 = streamEl();
        if (h0) h0.textContent = '当前模型可能不支持图片，改用纯文本重试…';
        answer = await qaLlmStream(baseMsgs, {
          signal,
          onDelta: (d) => {
            streamed += d;
            qaState.stream[convId] = streamed;
            const h = streamEl();
            if (h && onScreen()) h.innerHTML = qaMdToHtml(streamed);
          },
        });
        answer = answer || streamed;
        const h = streamEl();
        if (h) h.innerHTML = qaMdToHtml(answer);
        if (onScreen()) toast('模型不支持图片，已按纯文本回答');
      } catch (e2) {
        if (e2 && e2.name === 'AbortError') { answer = streamed; }
        else {
          const h = streamEl();
          if (h) h.textContent = '回答失败：' + (e2 && e2.message ? e2.message : '请稍后重试');
          if (onScreen()) toast('问答请求失败', 'warn');
        }
      }
    } else {
      const h = streamEl();
      if (h) h.textContent = '回答失败：' + (e && e.message ? e.message : '请稍后重试');
      if (onScreen()) toast('问答请求失败', 'warn');
    }
  } finally {
    clearTimeout(slowTip);
    delete qaState.busyConvs[convId];
    delete qaState.controllers[convId];
    delete qaState.stream[convId];
    /* v3.15.0 非当前会话生成完成 → 计入抽屉未读角标 */
    if (qaState.conversationId !== convId && answer) {
      qaState.unread = qaState.unread || new Set();
      qaState.unread.add(convId);
      qaRenderDrawerBadge();
    }
    qaSyncSendState();
  }

  myMsgs.push({ role: 'assistant', content: answer || streamed || '（本轮未生成回答，可重发一次）' });
  if (onScreen()) renderQaMessages();

  /* 落库收尾：首问时已写入占位行，这里把它换成完整记录；
     若最终没生成出回答，就保留占位行 —— 左侧列表里这条会话与提问仍然看得到。 */
  let phId = 0;
  try { phId = await phPromise; } catch (e) { phId = 0; }
  try {
    if (answer) {
      if (phId) { try { await store.remove('qa_history', phId); } catch (e) { /* 占位删不掉不影响最终记录 */ } }
      await store.insert('qa_history', {
        conversation_id: convId, question: question + attachNote, answer,
      });
    }
    await qaReloadAll();
    if (qaState.all.some(x => x.conversation_id === convId)) delete qaState.local[convId];
    renderQaHistory();
  } catch (e) { /* 保存失败不影响使用 */ }
}
export function qaStop() {
  const c = qaState.controllers[qaState.conversationId];
  if (c) { try { c.abort(); } catch (e) { /* */ } }
}

/* ---------- 历史加载 / 会话切换 / 删除 ---------- */
export async function qaReloadAll() {
  try {
    const rows = await store.query('qa_history');
    qaState.all = (rows || []).slice(0, QA_HISTORY_LIMIT);
    qaState.loaded = true;
  } catch (e) { qaState.all = []; }
}
export function qaLoadConversation(cid) {
  const rows = qaState.all.filter(r => r.conversation_id === cid)
    .sort((a, b) => (a.id > b.id ? 1 : -1));
  const cloudMsgs = [];
  for (const r of rows) {
    cloudMsgs.push({ role: 'user', content: r.question });
    /* 占位行（answer 为空，生成失败/被中止时留下的）→ 给个明确提示，别让用户以为丢了 */
    cloudMsgs.push({ role: 'assistant', content: r.answer || '（这轮没有生成出回答，可以重新提问）' });
  }
  const mem = qaState.msgs[cid] || [];
  /* 正在生成、或内存里比云端还新（刚答完、正在落库）→ 用内存缓存，避免内容闪失；
     否则以云端记录为准重建（保证与落库内容一致）。 */
  if (qaState.busyConvs[cid] || mem.length > cloudMsgs.length) qaAttach(cid);
  else { qaState.msgs[cid] = cloudMsgs; qaAttach(cid); }
  renderQaMessages();
  renderQaHistory();
  qaSyncSendState();
}
export async function qaDeleteConversation(cid) {
  if (!window.confirm('删除该会话的全部问答记录？删除后不可恢复。')) return;
  try {
    const ids = qaState.all.filter(r => r.conversation_id === cid).map(r => r.id);
    for (const id of ids) await store.remove('qa_history', id);
    delete qaState.local[cid];
    delete qaState.msgs[cid];
    delete qaState.stream[cid];
    if (qaState.conversationId === cid) qaAttach(qaNewId());
    await qaReloadAll();
    renderQaMessages();
    renderQaHistory();
    qaSyncSendState();
    toast('会话已删除');
  } catch (e) {
    toast('删除失败：' + (e && e.message || e), 'warn');
  }
}

/* ---------- 初始化（DOM 就绪后调用） ---------- */
export function initQa() {
  if (!$('view-qa')) return;
  qaAttach(qaNewId());
  renderQaMessages();
  renderQaHistory();
  renderQaChips();
  qaSyncSendState();
  /* v3.9.9 技能状态条：输入框上方一行小字，标明本轮可用的取数技能与妙想 Key 状态 */
  qaRefreshSkillHint();
  /* v3.9.2 快捷提问卡片：事件委托绑在 #qaMessages（卡片本身随渲染重建） */
  bindQaExamples();
  /* v3.12.1 右侧「本会话提问」快速导航：一次性绑定（委托在容器上，列表随渲染重建） */
  bindQaJump();

  $('newChatBtn').addEventListener('click', () => {
    qaAttach(qaNewId());
    renderQaMessages();
    renderQaHistory();
    qaSyncSendState();
    const inp = $('qaInput');
    if (inp) inp.focus();
  });
  /* v3.15.0 手机抽屉：☰ 开关 / 遮罩关闭 / 新对话（角标渲染函数在顶层，sendQa 也要用） */
  const drawer = $('qaDrawer'), mask = $('qaDrawerMask');
  function qaOpenDrawer() {
    if (!drawer) return;
    drawer.hidden = false;
    if (mask) mask.hidden = false;
    qaState.unread.clear();
    qaRenderDrawerBadge();
    renderQaHistory();
  }
  function qaCloseDrawer() {
    if (drawer) drawer.hidden = true;
    if (mask) mask.hidden = true;
  }
  $('qaDrawerBtn').addEventListener('click', () => { drawer.hidden ? qaOpenDrawer() : qaCloseDrawer(); });
  if (mask) mask.addEventListener('click', qaCloseDrawer);
  $('qaDrawerClose').addEventListener('click', qaCloseDrawer);
  $('qaNewBtnM').addEventListener('click', () => {
    qaAttach(qaNewId());
    renderQaMessages();
    renderQaHistory();
    qaSyncSendState();
    qaCloseDrawer();
    const inp = $('qaInput');
    if (inp) { inp.focus(); }
  });
  $('qaSearch').addEventListener('input', renderQaHistory);
  $('qaSendBtn').addEventListener('click', sendQa);
  const stopBtn = $('qaStopBtn');
  if (stopBtn) stopBtn.addEventListener('click', qaStop);
  $('qaInput').addEventListener('input', qaSyncSendState);
  $('qaInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendQa(); }
  });
  /* 历史列表：事件委托（内容随渲染重建）—— 桌面列表与手机抽屉列表共用同一委托 */
  const histHandler = e => {
    const open = e.target.closest('[data-qa-open]');
    if (open) { qaLoadConversation(open.dataset.qaOpen); qaCloseDrawer(); return; }
    const del = e.target.closest('[data-qa-del]');
    if (del) { qaDeleteConversation(del.dataset.qaDel); }
  };
  $('qaHistoryList').addEventListener('click', histHandler);
  const listM = $('qaHistoryListM');
  if (listM) listM.addEventListener('click', histHandler);
  /* 附件（v3.13.1 起入口在「＋」菜单里，独立 📎 按钮已移除） */
  $('qaFileInput').addEventListener('change', async e => {
    for (const f of Array.from(e.target.files || [])) await qaAddFile(f);
    e.target.value = '';
    qaSyncSendState();
  });
  $('qaAttachChips').addEventListener('click', e => {
    const rm = e.target.closest('[data-qa-rm]');
    if (!rm) return;
    qaState.files.splice(Number(rm.dataset.qaRm), 1);
    renderQaChips();
    qaSyncSendState();
  });
  /* 语音输入（v3.17.0 起抽为全局工厂 sjCreateMic：问答输入框与「记一笔」弹窗共用
     同一套按住说话状态机，行为逐字保留）。SR 必须按下时才取 —— 部分浏览器的
     兼容层是页面加载完成后才注入的，提前取会拿到 undefined。 */
  if ($('qaMicBtn')) sjCreateMic({
    btn: $('qaMicBtn'), hintId: 'qaRecHint', hintHostSel: '.qa-composer',
    input: () => $('qaInput'), onInput: qaSyncSendState,
    onDone: () => toast('语音已转文字，可修改后发送'),
  });
  /* v3.17.0 「记一笔」语音入口按用户要求暂不启用（工厂已就绪，后续接手只需
     给 recModal 的自然语言行加一个按钮并调 sjCreateMic 即可，见 sjCreateMic 注释） */
}
/* ============================================================
   v3.17.0 按住说话 · 全局工厂（原 v3.16.0/3.16.1 问答页内联实现抽出复用）
   引擎A 浏览器原生 SR（实时上屏）；引擎B 录音 → 16k WAV → sjAsrTranscribe。
   v3.16.1 四道保险逐字保留：松手复查 / 无条件硬停 / 指针捕获 / 60s 保险丝。
   ============================================================ */
export async function qaBoot() {
  try { await qaReloadAll(); } catch (e) { /* 未登录等情况忽略 */ }
  renderQaHistory();
}


/* ============================================================
   v0.4.0 M3 legacy 桥：把经典脚本（kline-store / analysis-extra / qa-tools /
   data-hub）依赖的共享符号显式暴露到 globalThis。清单按源码依赖审计生成；
   直接赋值（压缩器两侧同步改名，勿改成字符串 eval——构建压缩后原名字不存在）。
   ============================================================ */
