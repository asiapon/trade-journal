#!/usr/bin/env node
/* ============================================================
   ops/cli.mjs —— 统一运维入口
   ------------------------------------------------------------
   三条发布通道 × 全部操作都在这里派发，不用记文件路径。

   用法：
     node ops/cli.mjs <通道> <操作> [参数]
     node ops/cli.mjs                     交互菜单
     node ops/cli.mjs help                完整帮助

   通道： cf | self | wb | dev
   ============================================================ */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, OPS, IS_WIN, DIST, WB_DIR, exists, dbIdMismatch } from './lib/paths.mjs';
import { loadEnvFile } from './lib/env.mjs';
import { C, title, step, ok, warn, info, kv, footer, die } from './lib/ui.mjs';

/* ============================================================
   通道 → 操作 定义
   ============================================================ */
const CF_OPS = {
  bootstrap: { desc: '首次：建 D1 库 + 远端建表', file: 'cf/bootstrap.mjs' },
  deploy: { desc: '构建 + 测试 + 发布 Worker', file: 'cf/deploy.mjs' },
  status: { desc: 'Worker / D1 / 表数据量 / RPC 探测', file: 'cf/status.mjs' },
  logs: { desc: '实时日志（--once 只抓一小段）', file: 'cf/logs.mjs' },
  remove: { desc: '删除 Worker + D1（数据丢失，需确认）', file: 'cf/remove.mjs' },
};

const WB_OPS = {
  sync: { desc: '构建 + 同步到发布暂存目录', file: 'wb/sync.mjs' },
  status: { desc: '检查暂存目录与 dist 是否一致', file: 'wb/status.mjs' },
};

const SELF_OPS = {
  deploy: { desc: '构建 + 同步 dist 到服务器（scp/rsync）', file: 'self/deploy.mjs' },
  install: { desc: '安装 / 升级服务（幂等）' },
  start: { desc: '启动服务' },
  stop: { desc: '停止服务' },
  restart: { desc: '重启服务' },
  status: { desc: '运行状态 / 端口 / 健康 / 数据库' },
  logs: { desc: '查看日志（-n 行数、-f 跟随）' },
  backup: { desc: '备份数据库与配置' },
  restore: { desc: '从备份恢复' },
  uninstall: { desc: '卸载（逐项确认）' },
  'reset-db': { desc: '快速重置应用库（秒级，不卸载）' },
  'reset-pg': { desc: '救援：重置 postgres 超管密码' },
};

/* ============================================================
   工具
   ============================================================ */
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - [...s].length));

/** 跑一个 ESM 操作模块 */
async function runModule(relFile, argv) {
  const abs = path.join(OPS, relFile);
  if (!exists(abs)) die('缺少模块：' + relFile);
  const mod = await import('file://' + abs.replace(/\\/g, '/'));
  if (typeof mod.run !== 'function') die('模块未导出 run()：' + relFile);
  await mod.run(argv);
}

/** 跑自托管平台的 shell / powershell 脚本 */
function runSelfScript(op, argv) {
  if (IS_WIN) {
    const ps1 = path.join(OPS, 'self', 'windows', op + '.ps1');
    if (!exists(ps1)) die(`Windows 没有 ${op} 这个操作（看 node ops/cli.mjs help）`);
    /* -NonInteractive：脚本里若有 Read-Host 会立即失败而不是无声挂住；
       -NoProfile：避免用户 profile 干扰（别名/执行策略） */
    const p = spawnSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, ...argv],
      { stdio: 'inherit', cwd: REPO },
    );
    if (p.error) die('启动 PowerShell 失败：' + p.error.message);
    process.exit(p.status ?? 1);
  } else {
    const sh = path.join(OPS, 'self', 'linux', op + '.sh');
    if (!exists(sh)) die(`Linux 没有 ${op} 这个操作（看 node ops/cli.mjs help）`);
    const p = spawnSync('bash', [sh, ...argv], { stdio: 'inherit', cwd: REPO });
    if (p.error) die('启动 bash 失败：' + p.error.message);
    process.exit(p.status ?? 1);
  }
}

/* ============================================================
   帮助
   ============================================================ */
function printHelp() {
  title('操作日志 · 运维入口');
  console.log(`
  ${C.bold('用法')}  node ops/cli.mjs <通道> <操作> [参数]`);
  console.log(`        不带参数 = 交互菜单\n`);

  const block = (name, label, ops, extra = '') => {
    console.log(`  ${C.b(`${label}`)}  ${C.d('(' + name + ')')}`);
    for (const [k, v] of Object.entries(ops)) {
      console.log(`    ${pad(k, 12)} ${v.desc}`);
    }
    if (extra) console.log(`    ${C.d(extra)}`);
    console.log('');
  };

  block('cf', 'Cloudflare Workers + D1 —— 纯命令行发布', CF_OPS,
    '需要 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID（写在 .env.local）');
  block('self', '自托管服务器 —— 完整运维（安装到卸载）', SELF_OPS,
    IS_WIN ? '当前平台 Windows：脚本在 ops/self/windows/' : '当前平台 Linux/macOS：脚本在 ops/self/linux/');
  block('wb', 'WorkBuddy 托管 —— 半自动（仍需界面点发布）', WB_OPS);

  console.log(`  ${C.b('开发')}  ${C.d('(dev)')}`);
  console.log(`    ${pad('serve', 12)} 本地开发服务器（热更新，localhost:5173）`);
  console.log(`    ${pad('preview', 12)} 构建并预览产物（localhost:4173）`);
  console.log(`    ${pad('check', 12)} 只体检：构建 + 产物校验 + 测试`);
  console.log(`    ${pad('env', 12)} 生成 .env.local 凭据模板`);
  console.log('');

  footer([
    C.d('示例：'),
    '  node ops/cli.mjs cf status',
    '  node ops/cli.mjs self backup',
    '  node ops/cli.mjs wb sync',
    '',
    C.d('也可以直接用封装脚本：') + ' publish.bat check  /  ./publish.sh check',
    C.d('完整文档：') + ' ops/README.md',
  ]);
}

/* ============================================================
   交互菜单
   ============================================================ */
async function menu() {
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  title('操作日志 · 运维入口');
  console.log(`
    1) Cloudflare  发布（纯命令行上线）
    2) Cloudflare  状态
    3) 自托管      安装 / 升级
    4) 自托管      启动 / 停止 / 重启
    5) 自托管      状态 / 日志
    6) 自托管      备份 / 恢复
    7) 自托管      卸载
    8) WorkBuddy   同步发布目录
    9) 体检 + 本地预览
    h) 完整帮助
    0) 退出
`);
  const sel = (await rl.question('  请输入编号：')).trim();
  rl.close();

  const map = {
    1: ['cf', 'deploy'],
    2: ['cf', 'status'],
    3: ['self', 'install'],
    5: ['self', 'status'],
    6: ['self', 'backup'],
    7: ['self', 'uninstall'],
    8: ['wb', 'sync'],
    9: ['dev', 'preview'],
  };

  if (sel === '0') return;
  if (sel.toLowerCase() === 'h') { printHelp(); return; }
  if (sel === '4') {
    const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
    const a = (await rl2.question('  启动(1) / 停止(2) / 重启(3)：')).trim();
    rl2.close();
    return dispatch('self', a === '1' ? 'start' : a === '2' ? 'stop' : a === '3' ? 'restart' : '');
  }
  if (sel === '6') {
    const rl3 = readline.createInterface({ input: process.stdin, output: process.stdout });
    const a = (await rl3.question('  备份(1) / 恢复(2)：')).trim();
    rl3.close();
    return dispatch('self', a === '1' ? 'backup' : a === '2' ? 'restore' : '');
  }
  const hit = map[sel];
  if (!hit) { die('编号无效'); }
  return dispatch(hit[0], hit[1]);
}

/* ============================================================
   派发
   ============================================================ */
async function dispatch(channel, op, argv = []) {
  if (!op) { printHelp(); process.exit(1); }

  switch (channel) {
    case 'cf': {
      const def = CF_OPS[op];
      if (!def) die(`Cloudflare 没有「${op}」。可用：${Object.keys(CF_OPS).join(' / ')}`);
      loadEnvFile();
      await runModule(def.file, argv);
      return;
    }
    case 'wb': {
      const def = WB_OPS[op];
      if (!def) die(`WorkBuddy 没有「${op}」。可用：${Object.keys(WB_OPS).join(' / ')}`);
      await runModule(def.file, argv);
      return;
    }
    case 'self': {
      const def = SELF_OPS[op];
      if (!def) die(`自托管没有「${op}」。可用：${Object.keys(SELF_OPS).join(' / ')}`);
      /* deploy 是跨平台 Node 实现（scp/rsync），其余是各平台的系统脚本 */
      if (def.file) { loadEnvFile(); await runModule(def.file, argv); return; }
      runSelfScript(op, argv);
      return;
    }
    case 'dev': {
      const { prepare } = await import('./lib/build.mjs');
      const npm = (args) => spawnSync('npm', args, { cwd: REPO, stdio: 'inherit', shell: true });
      if (op === 'serve') { const p = npm(['run', 'dev']); process.exit(p.status ?? 1); }
      if (op === 'preview') {
        prepare({ withTest: false });
        info('打开 http://localhost:4173');
        const p = npm(['run', 'preview']);
        process.exit(p.status ?? 1);
      }
      if (op === 'check') { prepare(); console.log('\n' + C.g('✓ 体检通过，产物可直接发布')); return; }
      if (op === 'env') { makeEnv(); return; }
      die(`dev 没有「${op}」。可用：serve / preview / check / env`);
      return;
    }
    default:
      die(`未知通道「${channel}」。可用：cf / self / wb / dev（用 help 看详情）`);
  }
}

/** 生成 .env.local 模板 */
function makeEnv() {
  const f = path.join(REPO, '.env.local');
  title('生成凭据模板');
  if (exists(f)) {
    warn('.env.local 已存在，不覆盖。当前内容：');
    console.log('');
    console.log(fs.readFileSync(f, 'utf8').split('\n').map((l) => '    ' + l).join('\n'));
    return;
  }
  const tpl = `# 发布与运维凭据（本文件已被 .gitignore 忽略，不会提交）
# 填完直接跑 ops 命令，两个封装脚本也会自动加载

# Cloudflare：dash.cloudflare.com -> My Profile -> API Tokens
# 权限至少需要 Workers Scripts:Edit + D1:Edit
CLOUDFLARE_API_TOKEN=

# 账户 ID：Cloudflare 控制台 -> Workers 概览页右下角
CLOUDFLARE_ACCOUNT_ID=

# 自托管（可选，user@host 形式）
SELF_HOST=
SELF_PATH=/opt/stockjournal/dist
`;
  fs.writeFileSync(f, tpl, 'utf8');
  try { fs.chmodSync(f, 0o600); } catch { /* Windows 无此概念 */ }
  ok('已生成 .env.local' + (IS_WIN ? '' : '（权限 600）'));
  info('编辑：' + (IS_WIN ? 'notepad .env.local' : 'nano .env.local'));
}

/* ============================================================
   概览：不带参数且非 TTY 时打印状态摘要
   ============================================================ */
function overview() {
  title('操作日志 · 运维概览');
  const rows = [];
  rows.push(['仓库', REPO]);
  rows.push(['平台', IS_WIN ? 'Windows' : process.platform]);
  rows.push(['dist', exists(path.join(DIST, 'index.html')) ? '已构建' : C.d('未构建')]);
  rows.push(['暂存目录', exists(WB_DIR) ? '已同步' : C.d('未生成')]);
  const mm = dbIdMismatch();
  rows.push(['CF 配置', mm ? C.y('两份 database_id 不一致') : C.d('未检查/一致')]);
  rows.push(['CF 凭据', process.env.CLOUDFLARE_API_TOKEN ? '已配置' : C.d('未配置（cf 通道不可用）')]);
  kv(rows);
  console.log('');
  info('交互菜单：node ops/cli.mjs        完整帮助：node ops/cli.mjs help');
}

/* ============================================================
   启动
   ============================================================ */
loadEnvFile();

/* 顶层别名：把常用简写映射成 <通道> <操作>。
   只收安全操作 —— 发布/删除这类不在列，必须显式写通道，避免手滑。 */
const TOP_ALIAS = {
  check: ['dev', 'check'],
  env: ['dev', 'env'],
  serve: ['dev', 'serve'],
  preview: ['dev', 'preview'],
};

let [, , rawChannel, rawOp, ...rest] = process.argv;

if (rawChannel && TOP_ALIAS[rawChannel] && !rawOp) {
  [rawChannel, rawOp] = TOP_ALIAS[rawChannel];
  rest = [];
}

const argv = rest;

if (!rawChannel) {
  if (process.stdin.isTTY) {
    await menu();
  } else {
    overview();
  }
} else if (rawChannel === 'help' || rawChannel === '-h' || rawChannel === '--help') {
  printHelp();
} else if (rawChannel === 'version' || rawChannel === '-v') {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  console.log(`trade-journal ${pkg.version || '?'}`);
} else {
  await dispatch(rawChannel, rawOp, argv);
}
