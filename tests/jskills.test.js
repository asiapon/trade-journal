/* JS 技能包（features/jskills.js）沙箱与安装校验单测：不联网，fake localStorage */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};
globalThis.fetch = vi.fn();

import { jskillsList, jskillInstallFromUrl, jskillRemove, jskillToggle, jskillAgentTools, jskillExec } from '../src/features/jskills.js';

const PKG = {
  id: 'demo-skill', name: '演示技能', version: '1.0.0', description: '测试',
  tools: [{ name: 'echo', description: '原样返回' }, { name: 'fetch_sum', description: '抓取并求和' }],
  code: `const t = {
    echo: (args) => 'echo:' + JSON.stringify(args),
    fetch_sum: async (args, ctx) => {
      const r = await ctx.http('https://x.test/nums');
      const j = await r.json();
      return 'sum:' + j.nums.reduce((a, b) => a + b, 0);
    },
  }; return t;`,
};

describe('jskills 安装与校验', () => {
  beforeEach(() => { store.clear(); globalThis.fetch.mockReset(); });

  it('合法 SKILL.json 安装成功并列出', async () => {
    globalThis.fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => PKG });
    const p = await jskillInstallFromUrl('https://x.test/skill.json');
    expect(p.id).toBe('demo-skill');
    expect(jskillsList()).toHaveLength(1);
  });
  it('重复安装同 id → 覆盖不新增', async () => {
    globalThis.fetch.mockResolvedValue({ ok: true, json: async () => PKG });
    await jskillInstallFromUrl('u1'); await jskillInstallFromUrl('u2');
    expect(jskillsList()).toHaveLength(1);
  });
  it('缺 description / 非法 id / 缺 code → 拒装', async () => {
    globalThis.fetch.mockResolvedValue({ ok: true, json: async () => ({ ...PKG, tools: [{ name: 'a' }] }) });
    await expect(jskillInstallFromUrl('u')).rejects.toThrow(/工具名非法/);
    globalThis.fetch.mockResolvedValue({ ok: true, json: async () => ({ ...PKG, id: 'BAD_ID' }) });
    await expect(jskillInstallFromUrl('u')).rejects.toThrow(/id/);
    globalThis.fetch.mockResolvedValue({ ok: true, json: async () => ({ ...PKG, code: '' }) });
    await expect(jskillInstallFromUrl('u')).rejects.toThrow(/code/);
  });
});

describe('jskills 沙箱执行', () => {
  beforeEach(async () => {
    store.clear(); globalThis.fetch.mockReset();
    globalThis.fetch.mockResolvedValueOnce({ ok: true, json: async () => PKG });
    await jskillInstallFromUrl('u');
  });

  it('agentTools：启用时出现 jskill 工具，停用后消失', () => {
    expect(jskillAgentTools()).toHaveLength(1);
    jskillToggle('demo-skill', false);
    expect(jskillAgentTools()).toHaveLength(0);
    jskillToggle('demo-skill', true);
  });
  it('echo 工具：同步返回字符串', async () => {
    expect(await jskillExec({ fn: 'echo', args: { a: 1 } })).toBe('echo:{"a":1}');
  });
  it('http 注入：技能内 ctx.http 走注入的 fetch', async () => {
    globalThis.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ nums: [1, 2, 3] }) });
    expect(await jskillExec({ fn: 'fetch_sum' })).toBe('sum:6');
  });
  it('未知工具 → 明确报错（绝不静默）', async () => {
    await expect(jskillExec({ fn: 'nope' })).rejects.toThrow(/未找到/);
  });
  it('删除后工具消失', async () => {
    jskillRemove('demo-skill');
    await expect(jskillExec({ fn: 'echo' })).rejects.toThrow(/未找到/);
  });
});
