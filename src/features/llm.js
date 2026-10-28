/* LLM 网关：自定义模型流式 + 免密云端补全（v0.11.0 自单体拆出） */
import { $, toast, fmt2, fmtP, fmtPct, pnlCls, esc, fmtTime, nowLocalInput, inferMarket, MKT_NAME } from '../shared/utils.js';
import { NetLog, sjTokenHeaders } from '../core/netlog.js';
import { StockDict } from '../core/stockdict.js';
import { DL } from '../core/data-layer.js';
import { emQuote, txQuote } from '../sources/quotes.js';
import { TABLES, BACKEND_URL, RPC_BASE, ACCESS_KEY, CLOUD_HOST, rpc, cloudStore, localStore, setStore, loadAll, saveSetting, sessionHooks, storageHooks } from '../storage/gateway.js';
import { S } from '../core/app-state.js';
import { cloudLlm } from '../app.js';
import { ModelMgr } from './quotes.js';

/* SSE 解析：自定义模型 / 后端代理 / 问答 Agent 三条通道共用。
   onDelta      —— 只要文本增量（普通对话用）
   onDeltaRaw   —— 收完整 delta 对象（问答的 function calling 需要 tool_calls，
                   只给文本会把工具调用丢掉，Agent 回路直接失效）
   两者可同时传。 */
async function consumeSse(res, onDelta, onDeltaRaw, signal) {
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '', text = '';
  while (true) {
    if (signal && signal.aborted) { try { reader.cancel(); } catch (e) { /* */ } break; }
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const data = s.slice(5).trim();
      if (!data || data === '[DONE]') continue;

      /* 先只做 JSON 解析：解析失败说明是心跳/注释行，跳过即可。
         解析成功后再看 error —— 上游错误必须抛出去，不能被这里吞掉。 */
      let j;
      try { j = JSON.parse(data); } catch (e) { continue; }
      if (j && j.error) {
        throw new Error('模型返回错误：' + (j.error.message || j.error.code || JSON.stringify(j.error).slice(0, 200)));
      }
      const d = j.choices && j.choices[0] && j.choices[0].delta;
      if (!d) continue;
      if (onDeltaRaw) try { onDeltaRaw(d); } catch (e) { /* 交给调用方自己处理 */ }
      if (d.content) {
        text += d.content;
        if (onDelta) try { onDelta(d.content); } catch (e) { /* 渲染失败不影响取流 */ }
      }
    }
  }
  return text;
}

export async function customLlmStream(m, messages, opts) {
  let url = m.baseUrl.replace(/\/+$/, '');
  if (!/\/chat\/completions$/.test(url)) url += '/chat/completions';
  const onDelta = (opts && opts.onDelta) || null;
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + m.apiKey },
      body: JSON.stringify({ model: m.model, messages, stream: true })
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error('自定义模型请求失败 HTTP ' + res.status + (t ? '：' + t.slice(0, 200) : ''));
    }
    const text = await consumeSse(res, onDelta);
    NetLog.push('llm', '自定义模型 ' + m.model, true, Date.now() - t0, `${text.length} 字`,
      { url: m.url || '', req: `${(messages || []).length} 条消息`, resp: `返回 ${text.length} 字` });
    return text;
  } catch (e) {
    NetLog.push('llm', '自定义模型 ' + m.model, false, Date.now() - t0, e.message || String(e), { url: m.url || '', err: e.message || String(e) });
    throw e;
  }
}

/* 后端代理通道（v3.21.0）：本地部署时由自托管后端代持 key 调云端模型。
   解决「浏览器 Origin=localhost 被云端拒绝」——服务端发请求不校验 Origin。
   要求后端配了 LLM_ENDPOINT + LLM_KEY，否则返回 503，自动降级到自定义模型。

   参数 opts：
     signal        AbortSignal（问答支持中止）
     onDelta       文本增量回调
     onDeltaRaw    完整 delta 回调（问答的 tool_calls 靠它）
     extraBody     附加请求体字段（如 tools）
   导出给 qa.js 复用，避免问答再写一套。 */
export async function backendLlmStream(modelId, messages, opts = {}) {
  const { signal, onDelta, onDeltaRaw, extraBody } = opts || {};
  const t0 = Date.now();
  const base = (BACKEND_URL || '');
  const url = base + '/api/llm/chat/completions';
  try {
    const res = await fetch(url, {
      method: 'POST',
      /* sjTokenHeaders 已含 Content-Type；再带 access key —— 后端 REQUIRE_KEY=1 时用它校验 */
      headers: { ...sjTokenHeaders(), 'x-wb-webapp-access-key': ACCESS_KEY },
      body: JSON.stringify(Object.assign({ model: modelId, messages, stream: true }, extraBody || {})),
      signal,
    });
    if (!res.ok) {
      let msg = '后端代理返回 HTTP ' + res.status;
      try { const j = await res.json(); if (j && j.msg) msg = j.msg; } catch (e) { /* 非 JSON */ }
      throw new Error(msg);
    }
    const text = await consumeSse(res, onDelta, onDeltaRaw, signal);
    NetLog.push('llm', '云端模型(代理) ' + modelId, true, Date.now() - t0, `${text.length} 字`,
      { url, req: `${(messages || []).length} 条消息`, resp: `返回 ${text.length} 字` });
    return text;
  } catch (e) {
    NetLog.push('llm', '云端模型(代理) ' + modelId, false, Date.now() - t0, e.message || String(e),
      { url, err: e.message || String(e) });
    throw e;
  }
}

export async function llmComplete(messages, opts) {
  const m = ModelMgr.cur;
  if (!m) throw new Error('尚未选择模型，请到「设置 → AI 模型」选择');

  /* 用户主动选了自定义模型：直达，不碰云端（省积分也省得绕） */
  if (m.custom) return customLlmStream(m, messages, opts);

  /* 云端模型的三级降级链：
     ① 同源 SDK（WorkBuddy 托管页面，Origin 天然正确）
     ② 后端代理（本地部署：后端持 key 代发，绕过 Origin 校验）
     ③ 都不可用 → 抛明确错误，由调用方决定是否提示切自定义模型
     任一环失败都记 NetLog，便于在「设置 → 网络日志」里看清断在哪。 */
  const errs = [];

  if (cloudLlm) {
    const llm = cloudLlm.llm || cloudLlm;   // SDK 命名空间：cloud.llm.chat
    const t0 = Date.now();
    let text = '';
    try {
      for await (const chunk of llm.chat.completions.create({ model: m.id, messages, stream: true })) {
        const d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
        if (d && d.content) { text += d.content; if (opts && opts.onDelta) try { opts.onDelta(d.content); } catch (e) { /* */ } }
      }
      NetLog.push('llm', '云端模型 ' + m.id, true, Date.now() - t0, `${text.length} 字`,
        { req: `${(messages || []).length} 条消息`, resp: `返回 ${text.length} 字` });
      return text;
    } catch (e) {
      NetLog.push('llm', '云端模型 ' + m.id, false, Date.now() - t0, e.message || String(e), { err: e.message || String(e) });
      errs.push('SDK：' + (e.message || e));
    }
  }

  try {
    return await backendLlmStream(m.id, messages, opts);
  } catch (e) {
    errs.push('后端代理：' + (e.message || e));
  }

  throw new Error(
    '云端模型不可用（已试过 SDK 与后端代理）。' +
    (errs.length ? '\n  ' + errs.join('\n  ') : '') +
    '\n改到「设置 → AI 模型」选一个自定义模型即可继续使用。',
  );
}

/* ============================================================
   交易解析：AI 优先（结构化 JSON），本地规则兜底
   ============================================================ */
export function nowStr() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} 周${'日一二三四五六'[d.getDay()]}`;
}