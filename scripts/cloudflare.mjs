/* Cloudflare 部署驱动（trade-journal）
   子命令：
     node scripts/cloudflare.mjs bootstrap  首次：确保 D1 存在 → 写 database_id 进 wrangler.toml → 远端建表
     node scripts/cloudflare.mjs deploy     构建 + 发布 Worker（日常更新）
     node scripts/cloudflare.mjs delete     删除部署：Worker + D1（需输入 yes 确认，或 --yes）
   环境变量（三个子命令都需要）：
     CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID
   wrangler 从本地 node_modules 取（首次先 npm install）。 */
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CF_DIR = path.join(ROOT, 'deploy', 'cloudflare');
const TOML = path.join(CF_DIR, 'wrangler.toml');
/* 仓库根还有一份 wrangler.toml —— Cloudflare 自动构建（裸 npx wrangler deploy）只读根目录。
   两份必须保持 database_id 一致，否则线上 Worker 会连到不同/不存在的库。 */
const ROOT_TOML = path.join(ROOT, 'wrangler.toml');
const DB_NAME = 'trade-journal';
const require2 = createRequire(path.join(ROOT, 'package.json'));

function wrangler() {
  const p = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  if (fs.existsSync(p)) return p;
  console.error('✗ 未找到 wrangler：先在仓库根目录 npm install（devDependencies 已含 wrangler）');
  process.exit(1);
}
function env() {
  const t = process.env.CLOUDFLARE_API_TOKEN, a = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!t || !a) {
    console.error('✗ 缺少环境变量：');
    console.error('  PowerShell: $env:CLOUDFLARE_API_TOKEN="..."; $env:CLOUDFLARE_ACCOUNT_ID="..."');
    console.error('  bash:       export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...');
    process.exit(1);
  }
  return { t, a };
}
function wRun(args, opts = {}) {
  const r = spawnSync(process.execPath, [wrangler(), ...args], {
    cwd: CF_DIR, encoding: 'utf8',
    env: { ...process.env, CLOUDFLARE_API_TOKEN: env().t, CLOUDFLARE_ACCOUNT_ID: env().a },
    ...opts,
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r;
}
function tomlDbId() {
  const m = fs.readFileSync(TOML, 'utf8').match(/^database_id\s*=\s*"([^"]+)"/m);
  return m ? m[1] : '';
}
function setTomlDbId(id) {
  for (const f of [TOML, ROOT_TOML]) {
    if (!fs.existsSync(f)) continue;
    let s = fs.readFileSync(f, 'utf8');
    if (/^database_id\s*=/m.test(s)) s = s.replace(/^database_id\s*=\s*"[^"]*"/m, `database_id = "${id}"`);
    else s += `\ndatabase_id = "${id}"\n`;
    fs.writeFileSync(f, s);
  }
}
/* 校验两份配置的 database_id 是否一致（不一致直接告警，避免静默连错库） */
function checkTomlSync() {
  if (!fs.existsSync(ROOT_TOML)) return;
  const read = f => (fs.readFileSync(f, 'utf8').match(/^database_id\s*=\s*"([^"]+)"/m) || [])[1] || '';
  const a = read(TOML), b = read(ROOT_TOML);
  if (a && b && a !== b) {
    console.error('⚠ database_id 不一致：');
    console.error('   deploy/cloudflare/wrangler.toml =', a);
    console.error('   仓库根 wrangler.toml           =', b);
    console.error('   两处必须相同，否则本地发布与 Cloudflare 自动构建会连不同库。');
  }
}

/* ---------- bootstrap ---------- */
function bootstrap() {
  checkTomlSync();
  const existing = tomlDbId();
  if (existing && existing !== 'TO_CREATE_ON_FIRST_DEPLOY') {
    console.log('✓ wrangler.toml 已配置 database_id =', existing, '（如需重建库请先跑 delete）');
  } else {
    console.log('—— 查找/创建 D1 数据库', DB_NAME, '——');
    const list = wRun(['d1', 'list', '--json'], { encoding: 'utf8' });
    let found = '';
    try {
      const arr = JSON.parse((list.stdout.match(/\[[\s\S]*\]/) || ['[]'])[0]);
      const hit = arr.find(x => x.name === DB_NAME);
      if (hit) found = hit.uuid;
    } catch (e) { /* 解析失败走 create */ }
    if (found) {
      console.log('✓ 库已存在：', found);
    } else {
      const cr = wRun(['d1', 'create', DB_NAME]);
      const m = (cr.stdout + cr.stderr).match(/database_id\s*=\s*"([0-9a-f-]{36})"/);
      if (!m) { console.error('✗ 创建失败（看上方输出）'); process.exit(1); }
      found = m[1];
      console.log('✓ 已创建：', found);
    }
    setTomlDbId(found);
    console.log('✓ database_id 已写入 wrangler.toml');
  }
  console.log('—— 远端建表（幂等可重跑）——');
  const r = wRun(['d1', 'execute', DB_NAME, '--remote', '-y', '--file=schema.d1.sql']);
  if (r.status !== 0) { console.error('✗ 建表失败（看上方输出；重复执行报「已存在」可忽略）'); process.exit(1); }
  console.log('✓ bootstrap 完成。下一步：npm run deploy:cf 发布站点');
}

/* ---------- deploy ---------- */
function deploy() {
  env();
  checkTomlSync();
  console.log('—— 构建 ——');
  execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });
  console.log('—— 发布 ——');
  const r = wRun(['deploy']);
  if (r.status !== 0) { console.error('✗ 发布失败'); process.exit(1); }
  console.log('✓ 完成（地址见上方输出，默认 https://<name>.<子域>.workers.dev）');
}

/* ---------- delete ---------- */
async function del() {
  env();
  const yes = process.argv.includes('--yes');
  const id = tomlDbId();
  console.log('将删除以下资源（不可恢复）：');
  console.log('  1) Worker「trade-journal」及其线上地址');
  console.log('  2) D1 数据库「' + DB_NAME + '」' + (id ? '（' + id + '）' : '') + ' —— 全部账号与记账数据');
  if (!yes) {
    const ans = spawnSync('node', ['-e', 'process.stdout.write("确认请输入 yes：")'], { stdio: 'inherit' });
    const buf = Buffer.alloc(16);
    let input = '';
    try {
      const fd = 0; // stdin
      const rl = await import('node:readline');
      const it = rl.createInterface({ input: process.stdin });
      for await (const line of it) { input = line.trim(); break; }
    } catch (e) { /* */ }
    if (input !== 'yes') { console.log('已取消'); return; }
  }
  console.log('—— 删除 Worker ——');
  wRun(['delete', '--name', 'trade-journal', '--yes']);
  if (id && id !== 'TO_CREATE_ON_FIRST_DEPLOY') {
    console.log('—— 删除 D1 ——');
    wRun(['d1', 'delete', DB_NAME, '--yes']);
    setTomlDbId('TO_CREATE_ON_FIRST_DEPLOY');
    console.log('✓ wrangler.toml database_id 已复位为占位符');
  }
  console.log('✓ Cloudflare 部署已删除（GitHub 代码不受影响；重装：npm run cf:bootstrap && npm run deploy:cf）');
}

const cmd = process.argv[2];
if (cmd === 'bootstrap') bootstrap();
else if (cmd === 'deploy') deploy();
else if (cmd === 'delete') del();
else { console.log('用法：node scripts/cloudflare.mjs <bootstrap|deploy|delete>'); process.exit(1); }
