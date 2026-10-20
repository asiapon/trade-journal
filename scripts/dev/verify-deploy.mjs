#!/usr/bin/env node
/* ============================================================
   scripts/dev/verify-deploy.mjs —— 发布后自检（必跑）
   ------------------------------------------------------------
   为什么要有它：2026-10-20 连续三次「发布成功」但用户打开是空壳/本地模式。
   每次都是"发完就说成功"，没在用户视角验证。这个脚本把那次教训固化成检查项。

   用法：
     node scripts/dev/verify-deploy.mjs <发布域名> [--key <期望key>] [--dir dist]

   例：
     node scripts/dev/verify-deploy.mjs https://xxx.app.workbuddy.host \
       --key wbpk_xxxxxxxx

   检查项（任一失败 → 退出码 1，并打印怎么修）：
     ① 页面可访问（HTTP 200）
     ② 产物里的 endpoint 与发布域名一致（防止前端还指向旧应用域名）
     ③ 产物里的 publishableKey 与 --key 一致（防止还带旧应用 key）
     ④ app_has_users 返回 {ok,...} 信封（裸值会让前端静默降级本地模式）
     ⑤ RPC 路径不带 query 也能通（sharecode 只属于页面 URL）
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { REPO, DIST } from '../lib/paths.mjs';
import { loadEnvFile } from '../lib/env.mjs';
import { C, title, step, ok, warn, bad, info, kv, footer, die } from '../lib/ui.mjs';

/* ---------- 参数 ---------- */
const argv = process.argv.slice(2);
const url = argv.find((a) => /^https?:\/\//.test(a));
const takeOpt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] || '') : '';
};
const expectKey = takeOpt('--key');
const sharecode = takeOpt('--sharecode');
const distDir = path.resolve(takeOpt('--dir') || DIST);

if (!url) {
  die(
    '用法：node scripts/dev/verify-deploy.mjs <发布域名> [选项]\n' +
    '  --key       wbpk_xxx     期望的 publishableKey（强烈建议传）\n' +
    '  --sharecode xxx          页面的分享码（不带会被 403）\n' +
    '  --dir       dist         产物目录，默认 dist\n' +
    '  例：node scripts/dev/verify-deploy.mjs https://xxx.app.workbuddy.host \\\n' +
    '        --key wbpk_xxx --sharecode ABC123',
  );
}

loadEnvFile();
const origin = url.replace(/\/+$/, '').replace(/\/\?.*$/, '');
const host = origin.replace(/^https?:\/\//, '');

let failed = 0;
const pass = (t) => { ok(t); };
const fail = (t, how) => { failed++; bad(t); if (how) String(how).split('\n').forEach((l) => info('  ' + l)); };

/* ---------- 从产物里提取前端实际使用的配置 ---------- */
function scanBundle() {
  const assetsDir = path.join(distDir, 'assets');
  if (!fs.existsSync(assetsDir)) return { error: '找不到 ' + path.relative(REPO, assetsDir) + '（先 npm run build）' };
  const files = fs.readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
  if (!files.length) return { error: 'assets 里没有 JS 包' };
  const src = files.map((f) => fs.readFileSync(path.join(assetsDir, f), 'utf8')).join('\n');

  const keys = [...new Set((src.match(/wbpk_[A-Za-z0-9_]+/g) || []))];
  const hosts = [...new Set((src.match(/https:\/\/[a-z0-9-]+\.app\.workbuddy\.host/gi) || []))];
  const retired = src.includes('stock-journal-07300');
  return { keys, hosts, retired, files };
}

/* ---------- 发起请求 ---------- */
async function post(fn, body, key) {
  try {
    const r = await fetch(`${origin}/.cloud/database/rest/rpc/${fn}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { 'x-wb-webapp-access-key': key } : {}) },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(15000),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: r.status, ct: r.headers.get('content-type') || '', text, json };
  } catch (e) {
    return { status: 0, error: e.message };
  }
}

/* ============================================================
   开始检查
   ============================================================ */
title('发布自检');
kv([
  ['发布域名', origin],
  ['产物目录', path.relative(REPO, distDir) || distDir],
  ['期望 key', expectKey || C.d('（未指定，只做格式检查）')],
]);

/* ---------- ① 页面 ---------- */
step('① 页面可访问');
/* 平台默认要求带 sharecode：直接打根路径返回 403，这是正常的访问保护，
   不是故障。所以有 sharecode 就带上，没有才用裸域名。 */
const pageUrl = sharecode ? `${origin}/?sharecode=${encodeURIComponent(sharecode)}` : origin + '/';
info('请求：' + pageUrl);
try {
  const r = await fetch(pageUrl, { signal: AbortSignal.timeout(15000) });
  if (r.status === 200) {
    const html = await r.text();
    const hasBundle = /assets\/index-[A-Za-z0-9_-]+\.js/.test(html);
    pass(`HTTP 200（${html.length} 字节）`);
    if (hasBundle) pass('index.html 引用了打包后的 assets');
    else fail('index.html 里没找到 assets/index-*.js 引用', '可能发布的是源码而非 dist 产物');
  } else if (r.status === 401 || r.status === 403) {
    if (sharecode) {
      fail(`HTTP ${r.status}（sharecode 无效或已失效）`, '从「设置—数据管理—应用」重新取链接');
    } else {
      fail(`HTTP ${r.status}（缺 sharecode）`, '这个应用要求带分享码访问。\n加 --sharecode <码> 重跑（码在发布链接的 ?sharecode= 后面）');
    }
  } else {
    fail(`HTTP ${r.status}`);
  }
} catch (e) {
  fail('页面请求失败：' + e.message, '域名写错了？或发布还没生效');
}

/* ---------- ②③ 产物配置 ---------- */
step('②③ 产物里的 endpoint 与 key');
const b = scanBundle();
if (b.error) {
  fail(b.error);
} else {
  if (b.retired) fail('产物里仍有已退役域名 stock-journal-07300');

  const badHosts = b.hosts.filter((h) => !h.includes(host));
  if (badHosts.length) {
    fail('产物里的云服务域名与发布域名不一致', '产物含：' + badHosts.join(', ') + '\n发布域名：' + origin + '\n改 src/storage/gateway.js 的 CLOUD_CONFIG.endpoint 后重新构建发布');
  } else if (b.hosts.length) {
    pass('endpoint 指向当前域名（' + b.hosts.join(', ') + '）');
  } else {
    warn('产物里没找到 *.app.workbuddy.host 字样（可能只在 file:// 兜底时用到）');
  }

  if (!b.keys.length) {
    fail('产物里没找到任何 wbpk_ 开头的 key');
  } else if (expectKey) {
    if (b.keys.length === 1 && b.keys[0] === expectKey) {
      pass('key 与期望值一致（且只有一处）');
    } else if (b.keys.includes(expectKey)) {
      fail(`产物里有 ${b.keys.length} 个 key，虽然包含期望值但不干净`, b.keys.join('\n') + '\n应该只有一处：ACCESS_KEY 必须复用 CLOUD_CONFIG.publishableKey');
    } else {
      fail('产物里的 key 不是期望的那个', '产物含：' + b.keys.join(', ') + '\n期望：' + expectKey + '\n改 src/storage/gateway.js 后重新构建发布');
    }
  } else {
    info('产物含 key：' + b.keys.join(', '));
  }
}

/* ---------- ④ RPC 信封 ---------- */
step('④ RPC 返回信封（最关键的一项）');
const useKey = expectKey || b.keys?.[0] || '';
if (!useKey) {
  fail('没有可用的 key，无法测试 RPC', '传 --key wbpk_xxx');
} else {
  const r = await post('app_has_users', {}, useKey);
  if (r.error) {
    fail('请求失败：' + r.error);
  } else if (r.status === 401) {
    fail('HTTP 401 —— key 被拒', 'key 与应用不匹配，或该应用的云服务还没激活');
  } else if (r.status !== 200) {
    fail(`HTTP ${r.status}`, r.text.slice(0, 200));
  } else if (r.json === null) {
    fail('返回的不是 JSON', '内容：' + r.text.slice(0, 200));
  } else if (typeof r.json === 'object' && 'ok' in r.json) {
    pass(`返回信封 ${JSON.stringify(r.json)}`);
    if (r.json.ok !== true) warn('ok 不为 true（若是首次部署，data=false 属正常）');
  } else {
    /* 就是这个坑：裸 boolean 让前端 `if (!r || !r.ok) throw` 抛异常 → 静默降级本地模式 */
    fail(
      '返回的不是 {ok,...} 信封，而是裸值：' + JSON.stringify(r.json),
      '前端 hasUsers() 里 `if (!r || !r.ok) throw` 会抛异常 → boot 的 catch 静默切本地模式。\n' +
      '修法：数据库里 DROP FUNCTION 后重建 app_has_users，返回 jsonb_build_object(\'ok\',true,\'data\',EXISTS(...))',
    );
  }
}

/* ---------- ⑤ 不带 query 的 RPC 路径 ---------- */
step('⑤ RPC 路径不能带 query');
const withQ = await post('app_has_users' + '?sharecode=x', {}, useKey);
if (withQ.status === 200) {
  info('带 query 也能通（平台允许，不影响）');
} else {
  pass(`带 query 被拒（HTTP ${withQ.status}），符合预期 —— 前端用相对路径不带 query，没问题`);
}

/* ---------- 汇总 ---------- */
console.log('');
if (failed === 0) {
  footer([
    C.g('✓ 全部通过，这个发布是真的可用'),
    '',
    '接下来手动确认一次：浏览器打开页面，应看到「首次初始化」或登录页，',
    '而不是「本地模式」徽标。这是唯一无法自动化的检查。',
  ]);
  process.exit(0);
} else {
  footer([
    C.r(`✗ ${failed} 项未通过 —— 不要告诉用户「已发布成功」`),
    '',
    '按上面的提示逐项修，修完重新跑本脚本，全绿再交付。',
  ]);
  process.exit(1);
}
