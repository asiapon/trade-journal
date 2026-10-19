/* JS 技能包（v0.12.0，路线 A）：SKILL.json 格式 + new Function 沙箱。
   与 SKILL.md/Python 技能包（仅自托管可执行）互补——JS 技能在三个部署环境
   （WorkBuddy 云端 / 自托管 / Cloudflare）都能安装执行，零服务端依赖。
   格式约定（安装时校验）：
   {
     "id": "my-skill",            // 小写字母数字连字符
     "name": "示例技能",
     "version": "1.0.0",
     "description": "一句话说明",
     "tools": [ { "name": "tool_a", "description": "给问答 Agent 的工具说明" } ],
     "code": "const t = { async tool_a(args, ctx) { ... } }; return t;"
   }
   沙箱约定：code 在 new Function('ctx', code) 中执行，只能用 ctx.http / ctx.now /
   ctx.utils；必须 return 一个 { 工具名: async (args, ctx) => 结果文本 } 的对象。 */

import { esc } from '../shared/utils.js';

const STORE = 'sj_jskills_v1';
const MAX_SKILLS = 20;
const MAX_CODE = 256 * 1024;
const EXEC_TIMEOUT = 15 * 1000;

function load() {
  try { return JSON.parse(localStorage.getItem(STORE) || '[]'); } catch (e) { return []; }
}
function save(list) {
  try { localStorage.setItem(STORE, JSON.stringify(list)); } catch (e) { /* 配额满：静默（技能体量小，罕见） */ }
}

function validate(pkg) {
  if (!pkg || typeof pkg !== 'object') throw new Error('SKILL.json 解析失败');
  if (!/^[a-z0-9-]{2,32}$/.test(pkg.id || '')) throw new Error('id 必须是 2-32 位小写字母/数字/连字符');
  if (!pkg.name || String(pkg.name).length > 40) throw new Error('name 缺失或过长');
  if (!Array.isArray(pkg.tools) || !pkg.tools.length) throw new Error('tools 必须是非空数组');
  for (const t of pkg.tools) {
    if (!t || !/^[a-z_][a-z0-9_]{1,40}$/.test(t.name || '')) throw new Error('工具名非法：' + (t && t.name));
    if (!t.description) throw new Error('工具 ' + t.name + ' 缺 description（问答 Agent 靠它理解用途）');
  }
  if (typeof pkg.code !== 'string' || pkg.code.length < 8) throw new Error('code 缺失');
  if (pkg.code.length > MAX_CODE) throw new Error('code 超过 256KB 上限');
  return {
    id: pkg.id, name: String(pkg.name), version: String(pkg.version || '1.0.0'),
    description: String(pkg.description || ''), tools: pkg.tools.map(t => ({ name: t.name, description: String(t.description) })),
    code: pkg.code, enabled: true, installedAt: Date.now(),
  };
}

async function fetchJson(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12000);
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}

/* 沙箱执行上下文：受控网络 + 时间 + 少量工具 */
function makeCtx() {
  return {
    now: () => Date.now(),
    async http(url, opts) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 10000);
      try {
        const r = await fetch(String(url), Object.assign({}, opts, { signal: ac.signal }));
        return { ok: r.ok, status: r.status, json: () => r.json(), text: () => r.text() };
      } finally { clearTimeout(timer); }
    },
    utils: { esc },
  };
}

/* ---------- 对外 API ---------- */
export function jskillsList() { return load(); }

export async function jskillInstallFromUrl(url) {
  const pkg = validate(await fetchJson(url));
  const list = load();
  const i = list.findIndex(s => s.id === pkg.id);
  if (i >= 0) { pkg.enabled = list[i].enabled; list[i] = pkg; } else {
    if (list.length >= MAX_SKILLS) throw new Error('最多安装 ' + MAX_SKILLS + ' 个 JS 技能');
    list.push(pkg);
  }
  save(list);
  return pkg;
}

export function jskillRemove(id) {
  save(load().filter(s => s.id !== id));
}

export function jskillToggle(id, on) {
  const list = load();
  const s = list.find(x => x.id === id);
  if (s) { s.enabled = !!on; save(list); }
}

/* 问答 Agent 工具：所有启用的 JS 技能合并成一个 jskill 工具（fn=工具名分发表） */
export function jskillAgentTools() {
  const on = load().filter(s => s.enabled !== false);
  if (!on.length) return [];
  const detail = on.map(s => '技能「' + s.name + '」（' + s.id + '）可用工具：'
    + s.tools.map(t => t.name + '（' + t.description + '）').join('；')).join('；');
  return [{ type: 'function', function: {
    name: 'jskill',
    description: '调用已安装的 JS 技能（本地沙箱执行，跨环境可用）。' + detail + ' 参数按工具签名传对象键值。',
    parameters: { type: 'object', properties: {
      fn: { type: 'string', description: '工具名，如 tool_a' },
      args: { type: 'object', description: '工具参数键值对' },
    }, required: ['fn'] },
  } }];
}

export async function jskillExec(args) {
  const fn = String(args && args.fn || '');
  const on = load().filter(s => s.enabled !== false);
  for (const sk of on) {
    if (!sk.tools.some(t => t.name === fn)) continue;
    let tools;
    try {
      tools = new Function('ctx', '"use strict";\n' + sk.code + '\n;')(makeCtx());
    } catch (e) { throw new Error('技能 ' + sk.id + ' 代码执行失败：' + (e && e.message || e)); }
    const impl = tools && tools[fn];
    if (typeof impl !== 'function') throw new Error('技能 ' + sk.id + ' 未返回工具 ' + fn);
    const ctx = makeCtx();
    const out = await Promise.race([
      Promise.resolve(impl(args && args.args || {}, ctx)),
      new Promise((_, rej) => setTimeout(() => rej(new Error('技能执行超时（15s）')), EXEC_TIMEOUT)),
    ]);
    return typeof out === 'string' ? out : JSON.stringify(out);
  }
  throw new Error('未找到 JS 技能工具 ' + fn + '。可用：'
    + on.flatMap(s => s.tools.map(t => t.name)).join('、'));
}
