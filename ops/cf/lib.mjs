/* ============================================================
   ops/cf/lib.mjs —— Cloudflare 通道共用
   ------------------------------------------------------------
   wrangler 一律从本地 node_modules 取（首次 npm install），
   不依赖全局安装的 wrangler，避免版本漂移。
   ============================================================ */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { REPO, CFDIR } from '../lib/paths.mjs';
import { needEnv, loadEnvFile } from '../lib/env.mjs';
import { die, C } from '../lib/ui.mjs';

export const WORKER_NAME = 'trade-journal';
export const DB_NAME = 'trade-journal';

/** 取 wrangler 入口脚本路径，找不到直接退出 */
export function wranglerBin() {
  const p = path.join(REPO, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  if (!fs.existsSync(p)) {
    die('未找到 wrangler。先在仓库根跑 npm install（devDependencies 已含 wrangler）');
  }
  return p;
}

/** 校验凭据，加载 .env.local 后再判断 */
export function ensureCreds() {
  loadEnvFile();
  needEnv(
    ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'],
    '获取：dash.cloudflare.com → My Profile → API Tokens（需 Workers Scripts:Edit + D1:Edit）',
  );
}

/** 在 deploy/cloudflare 目录下跑 wrangler（那里有主配置与 schema） */
export function wrangler(args, opts = {}) {
  const r = spawnSync(process.execPath, [wranglerBin(), ...args], {
    cwd: CFDIR,
    encoding: 'utf8',
    env: {
      ...process.env,
      CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
      CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
    },
    ...opts,
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r;
}

/** 跑 wrangler 并捕获输出（不打印），用于解析 JSON */
export function wranglerCapture(args) {
  const r = spawnSync(process.execPath, [wranglerBin(), ...args], {
    cwd: CFDIR,
    encoding: 'utf8',
    env: {
      ...process.env,
      CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
      CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
    },
  });
  return { out: (r.stdout || '') + (r.stderr || ''), status: r.status };
}

/** 从任意输出里抠 JSON 数组/对象 */
export function extractJson(text, kind = 'array') {
  const re = kind === 'array' ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/;
  const m = text.match(re);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

/** 直接调 Cloudflare REST API（比解析 wrangler 文本稳） */
export async function cfApi(pathname) {
  const acc = process.env.CLOUDFLARE_ACCOUNT_ID;
  const tok = process.env.CLOUDFLARE_API_TOKEN;
  const url = `https://api.cloudflare.com/client/v4/accounts/${acc}${pathname}`;
  let r;
  try {
    r = await fetch(url, {
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    return { ok: false, error: '网络请求失败：' + e.message };
  }
  let j = null;
  try { j = await r.json(); } catch { /* */ }
  if (!j) return { ok: false, error: `HTTP ${r.status}` };
  if (!j.success) {
    const msg = (j.errors || []).map((x) => `${x.code} ${x.message}`).join('; ') || `HTTP ${r.status}`;
    return { ok: false, error: msg, raw: j };
  }
  return { ok: true, data: j.result };
}

export { C };
