/* ============================================================
   scripts/lib/env.mjs —— 加载仓库根 .env.local
   ------------------------------------------------------------
   优先级：已存在的环境变量 > .env.local 里的值。
   这样 CI 里 export 的凭据不会被文件覆盖，本地开发也只需填一次文件。
   .env.local 已被 .gitignore 忽略，不会误提交。
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './paths.mjs';

const FILE = path.join(REPO, '.env.local');

/** 解析 KEY=VALUE；支持 # 注释、行尾空白、单双引号包裹 */
function parse(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

/** 加载到 process.env（不覆盖已有值）。返回实际注入的键名数组。 */
export function loadEnvFile(silent = true) {
  let text = '';
  try { text = fs.readFileSync(FILE, 'utf8'); } catch { return []; }
  const parsed = parse(text);
  const injected = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (v === '') continue;                 // 空值视为未填
    if (process.env[k] !== undefined && process.env[k] !== '') continue;
    process.env[k] = v;
    injected.push(k);
  }
  if (!silent && injected.length) {
    console.log('  \x1b[90m· 已从 .env.local 读取：' + injected.join(', ') + '\x1b[0m');
  }
  return injected;
}

/** 取一个必填环境变量，缺失时给出获取指引并退出 */
export function needEnv(keys, hint) {
  const missing = keys.filter((k) => !process.env[k]);
  if (!missing.length) return;
  console.error('\n  \x1b[31m✗ 缺少环境变量：' + missing.join(', ') + '\x1b[0m');
  console.error('\n  推荐：写进仓库根的 .env.local（跑一次 `node scripts/cli.mjs env` 会生成模板）');
  for (const k of missing) console.error('    ' + k + '=');
  if (hint) console.error('\n  ' + hint);
  process.exit(1);
}

export { FILE as ENV_FILE };
