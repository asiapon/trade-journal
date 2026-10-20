/* ============================================================
   ops/lib/paths.mjs —— 全项目唯一的路径解析处
   ------------------------------------------------------------
   约定（改目录结构时只改这里）：
     REPO      仓库根
     DIST      构建产物        <REPO>/dist
     DEPLOY    部署物          <REPO>/deploy
     SELFHOST  自托管后端运行时 <REPO>/deploy/selfhost   ← server.js 在这，位置不可移
     CFDIR     Cloudflare 代码 <REPO>/deploy/cloudflare  ← wrangler 主配置指向这
     WB_DIR    WorkBuddy 暂存   <仓库外>/trade-journal-app

   为什么 deploy/ 不能挪：server.js 里 `path.join(__dirname,'..','..','dist')`
   硬指仓库根，ksync.js 里 `__dirname/../stock-dict.json` 硬指 deploy/。
   挪动会让线上自托管直接 404。
   ============================================================ */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 仓库根：ops/lib/ → 上两级 */
export const REPO = path.resolve(HERE, '..', '..');
export const DIST = path.join(REPO, 'dist');
export const DEPLOY = path.join(REPO, 'deploy');
export const SELFHOST = path.join(DEPLOY, 'selfhost');
export const CFDIR = path.join(DEPLOY, 'cloudflare');
export const OPS = path.join(REPO, 'ops');

/** WorkBuddy 发布暂存目录：在仓库外，可随时删除重建 */
export const WB_DIR = 'C:/lyz/workspace/trade-journal-app';

/** 两份 wrangler 配置 —— 必须保持 database_id 一致 */
export const TOML_CF = path.join(CFDIR, 'wrangler.toml');       // 本地发布用（显式 -c）
export const TOML_ROOT = path.join(REPO, 'wrangler.toml');      // Cloudflare 自动构建用

/** 构建产物必须存在的文件（少一个线上就打不开） */
export const DIST_REQUIRED = [
  'index.html',
  'stock-dict.json',
  'board-dict.json',
  'kline-store.js',
  'qa-tools.js',
  'analysis-extra.js',
  'data-hub.js',
];

/** 已退役域名：产物里出现即拒绝发布（云库地址已失效） */
export const RETIRED_HOST = 'stock-journal-07300';

export function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

/** 读某份 wrangler.toml 的 database_id */
export function readDbId(tomlPath) {
  try {
    const m = fs.readFileSync(tomlPath, 'utf8').match(/^database_id\s*=\s*"([^"]+)"/m);
    return m ? m[1] : '';
  } catch { return ''; }
}

/** 同时写两份 wrangler.toml 的 database_id，保持同步 */
export function writeDbId(id) {
  const touched = [];
  for (const f of [TOML_CF, TOML_ROOT]) {
    if (!exists(f)) continue;
    let s = fs.readFileSync(f, 'utf8');
    if (/^database_id\s*=/m.test(s)) s = s.replace(/^database_id\s*=\s*"[^"]*"/m, `database_id = "${id}"`);
    else s += `\ndatabase_id = "${id}"\n`;
    fs.writeFileSync(f, s);
    touched.push(path.relative(REPO, f));
  }
  return touched;
}

/** 两份配置的 database_id 是否一致；返回 null 表示一致或无法比较 */
export function dbIdMismatch() {
  if (!exists(TOML_CF) || !exists(TOML_ROOT)) return null;
  const a = readDbId(TOML_CF);
  const b = readDbId(TOML_ROOT);
  if (!a || !b || a === b) return null;
  return { cf: a, root: b };
}

/** 读自托管 .env 里的 PORT（默认 3000） */
export function readSelfPort() {
  try {
    const s = fs.readFileSync(path.join(SELFHOST, '.env'), 'utf8');
    const m = s.match(/^\s*PORT\s*=\s*(\d+)\s*$/m);
    return m ? Number(m[1]) : 3000;
  } catch { return 3000; }
}

/** 当前平台 */
export const IS_WIN = process.platform === 'win32';
