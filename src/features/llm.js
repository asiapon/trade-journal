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

export async function customLlmStream(m, messages, opts) {
  let url = m.baseUrl.replace(/\/+$/, '');
  if (!/\/chat\/completions$/.test(url)) url += '/chat/completions';
  const onDelta = (opts && opts.onDelta) || null;
  const t0 = Date.now();
  let text = '';
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
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '';
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
    NetLog.push('llm', '自定义模型 ' + m.model, true, Date.now() - t0, `${text.length} 字`,
      { url: m.url || '', req: `${(messages || []).length} 条消息`, resp: `返回 ${text.length} 字` });
    return text;
  } catch (e) {
    NetLog.push('llm', '自定义模型 ' + m.model, false, Date.now() - t0, e.message || String(e), { url: m.url || '', err: e.message || String(e) });
    throw e;
  }
}
export async function llmComplete(messages, opts) {
  const m = ModelMgr.cur;
  if (!m) throw new Error('尚未选择模型，请到「设置 → AI 模型」选择');
  if (m.custom) return customLlmStream(m, messages, opts);
  if (!cloudLlm) throw new Error('云端模型服务不可用');
  const llm = cloudLlm.llm || cloudLlm;   // SDK 命名空间：cloud.llm.chat
  const t0 = Date.now();
  let text = '';
  try {
    const params = { model: m.id, messages, stream: true };
    for await (const chunk of llm.chat.completions.create(params)) {
      const d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
      if (d && d.content) { text += d.content; if (opts && opts.onDelta) try { opts.onDelta(d.content); } catch (e) { /* */ } }
    }
    NetLog.push('llm', '云端模型 ' + m.id, true, Date.now() - t0, `${text.length} 字`,
      { req: `${(messages || []).length} 条消息`, resp: `返回 ${text.length} 字` });
    return text;
  } catch (e) {
    NetLog.push('llm', '云端模型 ' + m.id, false, Date.now() - t0, e.message || String(e), { err: e.message || String(e) });
    throw e;
  }
}

/* ============================================================
   交易解析：AI 优先（结构化 JSON），本地规则兜底
   ============================================================ */
export function nowStr() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} 周${'日一二三四五六'[d.getDay()]}`;
}