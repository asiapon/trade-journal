#!/usr/bin/env node
/* ============================================================
   一键发布（trade-journal）· v1.0
   ------------------------------------------------------------
   设计目标：不依赖 WorkBuddy 界面，命令行即可完成发布。

   用法：
     node scripts/publish.mjs cf            Cloudflare Workers + D1（推荐，纯命令行）
     node scripts/publish.mjs self          自托管（scp 到服务器）
     node scripts/publish.mjs wb            只做构建 + 同步到 WB 发布目录（需界面点发布）
     node scripts/publish.mjs local         本地构建并起服务预览
     node scripts/publish.mjs check         只做体检：构建 + 测试 + 产物校验

   前置：
     cf   → 设置 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID
     self → 设置 SELF_HOST=user@host（可选 SELF_PATH）
   ============================================================ */
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const WB_DIR = 'C:/lyz/workspace/trade-journal-app';

const C = { g: s => `\x1b[32m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m`, d: s => `\x1b[90m${s}\x1b[0m`, b: s => `\x1b[1m${s}\x1b[0m` };
const step = t => console.log('\n' + C.b('▶ ' + t));
const ok = t => console.log('  ' + C.g('✓') + ' ' + t);
const warn = t => console.log('  ' + C.y('!') + ' ' + t);
const die = t => { console.error('\n  ' + C.r('✗ ' + t)); process.exit(1); };
const run = (cmd, opts = {}) => execSync(cmd, { cwd: ROOT, stdio: 'inherit', ...opts });

/* ---------- 公共：构建 + 校验 ---------- */
function build() {
  step('构建');
  run('npm run build');
  if (!fs.existsSync(path.join(DIST, 'index.html'))) die('构建产物缺失：dist/index.html');
  ok('dist/ 生成完毕');
  verifyDist();
}

/* 产物体检：确认关键文件与关键配置都在，避免发出一个「打不开」的包 */
function verifyDist() {
  step('产物校验');
  const need = ['index.html', 'stock-dict.json', 'board-dict.json', 'kline-store.js', 'qa-tools.js', 'analysis-extra.js', 'data-hub.js'];
  const missing = need.filter(f => !fs.existsSync(path.join(DIST, f)));
  if (missing.length) die('产物缺少文件：' + missing.join(', '));
  ok(`${need.length} 个静态资源齐备`);

  const assets = fs.existsSync(path.join(DIST, 'assets')) ? fs.readdirSync(path.join(DIST, 'assets')) : [];
  if (!assets.some(f => f.endsWith('.js'))) die('assets/ 里没有 JS 包');
  ok('打包产物：' + assets.join(', '));

  /* 旧域名若残留，线上必然连不上云库 —— 直接拦下 */
  const js = assets.filter(f => f.endsWith('.js'))
    .map(f => fs.readFileSync(path.join(DIST, 'assets', f), 'utf8')).join('');
  if (js.includes('stock-journal-07300')) die('产物里仍有已退役的旧域名 stock-journal-07300，拒绝发布');
  if (!js.includes('WorkBuddyCloud') && !js.includes('createWorkBuddyCloud')) warn('未检测到云服务 SDK 引用（纯 RPC 部署可忽略）');
  ok('无失效域名残留');
}

function test() {
  step('单元测试');
  const r = spawnSync('npm', ['test'], { cwd: ROOT, stdio: 'inherit', shell: true });
  if (r.status !== 0) die('测试未通过，已中止发布');
  ok('测试通过');
}

/* ---------- 各发布通道 ---------- */
function publishCF() {
  const tok = process.env.CLOUDFLARE_API_TOKEN;
  const acc = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!tok || !acc) {
    console.log(C.y('\n  缺少 Cloudflare 凭据，无法用命令行发布。'));
    console.log('\n  ' + C.b('推荐做法') + '：把凭据写进仓库根的 ' + C.b('.env.local') + '，之后无需再管');
    console.log('    CLOUDFLARE_API_TOKEN=你的token');
    console.log('    CLOUDFLARE_ACCOUNT_ID=你的account id');
    console.log(C.d('\n  没有这个文件？跑一次就生成模板：'));
    console.log(C.d('    Windows:  publish.bat env'));
    console.log(C.d('    Linux/mac: ./publish.sh env'));
    console.log(C.d('\n  临时用法（当前窗口有效）：'));
    console.log('    PowerShell:  $env:CLOUDFLARE_API_TOKEN="..."; $env:CLOUDFLARE_ACCOUNT_ID="..."');
    console.log('    bash:        export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...');
    console.log(C.d('\n  凭据获取：dash.cloudflare.com → My Profile → API Tokens（需 Workers + D1 编辑权限）'));
    die('未设置 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID');
  }
  build();
  test();
  step('部署到 Cloudflare Workers');
  run('node node_modules/wrangler/bin/wrangler.js deploy -c deploy/cloudflare/wrangler.toml', {
    env: { ...process.env, CLOUDFLARE_API_TOKEN: tok, CLOUDFLARE_ACCOUNT_ID: acc },
  });
  ok('Cloudflare 部署完成（地址见上方 wrangler 输出）');
  console.log(C.d('\n  提示：首次部署若 D1 还没建表，先跑 npm run cf:bootstrap'));
}

function publishSelf() {
  const host = process.env.SELF_HOST;
  if (!host) die('未设置 SELF_HOST，例如：SELF_HOST=root@1.2.3.4 node scripts/publish.mjs self');
  build();
  test();
  step('同步到自托管服务器');
  run(`node scripts/sync-self.mjs`, { env: { ...process.env } });
  ok('已同步。如需重启：ssh ' + host + ' "systemctl restart stockjournal"');
}

function publishWB() {
  build();
  step('同步到 WorkBuddy 发布目录');
  run('node scripts/sync-wb.mjs');
  ok('已同步到 ' + WB_DIR);
  console.log(C.y('\n  注意：这条通道仍需要在 WorkBuddy 界面点「发布」才算上线。'));
  console.log(C.d('  想完全命令行发布，请用：node scripts/publish.mjs cf'));
}

function publishLocal() {
  build();
  step('启动本地预览');
  console.log('  打开 http://localhost:4173');
  run('npm run preview');
}

function checkOnly() {
  build();
  test();
  console.log('\n' + C.g('✓ 体检通过，产物可直接发布'));
}

/* ---------- 入口 ---------- */
const cmd = process.argv[2] || 'help';

/* Windows 旧控制台默认 GBK，Node 按 UTF-8 输出中文会乱码。
   这里在启动时切换到 UTF-8 代码页（失败无所谓），保证中文提示可读。 */
if (process.platform === 'win32') {
  const r = spawnSync('chcp', ['65001'], { shell: true, stdio: 'ignore' });
  void r;
}

console.log(C.b('\n操作日志 · 发布工具') + C.d('  (node scripts/publish.mjs <cf|self|wb|local|check>)'));

switch (cmd) {
  case 'cf': publishCF(); break;
  case 'self': publishSelf(); break;
  case 'wb': publishWB(); break;
  case 'local': publishLocal(); break;
  case 'check': checkOnly(); break;
  default:
    if (cmd !== 'help' && cmd !== '--help' && cmd !== '-h') {
      console.log(C.r('\n  未知命令：' + cmd));
    }
    console.log('\n可用命令：');
    console.log('  check   只体检不发布（构建 + 测试 + 产物校验）');
    console.log('  cf      Cloudflare Workers + D1（纯命令行发布）');
    console.log('  local   本地构建 + 预览');
    console.log('  wb      构建 + 同步到 WorkBuddy 发布目录（需界面点发布）');
    console.log('  self    自托管（scp 同步 + 重启提示）');
    console.log(C.d('\n  也可以直接用：publish.bat（Windows）或 ./publish.sh（Linux/macOS）'));
    console.log(C.d('  凭据写在仓库根的 .env.local，两个脚本都会自动加载。'));
    process.exit(cmd === 'help' ? 0 : 1);
}
