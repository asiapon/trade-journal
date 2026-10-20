/* ============================================================
   ops/lib/build.mjs —— 构建 + 产物体检 + 单元测试
   ------------------------------------------------------------
   三条通道（CF / 自托管 / WB）发布前都要走这一遍，
   任一步失败直接退出，避免把一个「打不开」的包发出去。
   ============================================================ */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, DIST, DIST_REQUIRED, RETIRED_HOST } from './paths.mjs';
import { step, ok, warn, info, die, C } from './ui.mjs';

/** 跑一次 npm 子命令，实时透传输出 */
function npm(args, extraEnv = {}) {
  const r = spawnSync('npm', args, {
    cwd: REPO,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, ...extraEnv },
  });
  return r.status === 0;
}

export function build() {
  step('构建');
  if (!npm(['run', 'build'])) die('构建失败，已中止');
  if (!fs.existsSync(path.join(DIST, 'index.html'))) die('构建产物缺失：dist/index.html');
  ok('dist/ 生成完毕');
  return verify();
}

function verify() {
  step('产物校验');

  const missing = DIST_REQUIRED.filter((f) => !fs.existsSync(path.join(DIST, f)));
  if (missing.length) die('产物缺少文件：' + missing.join(', '));
  ok(`${DIST_REQUIRED.length} 个静态资源齐备`);

  const assetsDir = path.join(DIST, 'assets');
  const assets = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : [];
  const jsFiles = assets.filter((f) => f.endsWith('.js'));
  if (!jsFiles.length) die('assets/ 里没有 JS 包，构建可能不完整');
  const cssFiles = assets.filter((f) => f.endsWith('.css'));
  ok('打包产物：' + [...jsFiles, ...cssFiles].join(', '));

  /* 旧域名若残留在产物里，线上必然连不上云库 —— 直接拦下 */
  const bundle = jsFiles
    .map((f) => fs.readFileSync(path.join(assetsDir, f), 'utf8'))
    .join('');
  if (bundle.includes(RETIRED_HOST)) {
    die(`产物里仍有已退役的旧域名 ${RETIRED_HOST}，拒绝发布`);
  }
  ok('无失效域名残留');

  if (!bundle.includes('WorkBuddyCloud') && !bundle.includes('createWorkBuddyCloud')) {
    warn('未检测到云服务 SDK 引用（纯 RPC 部署可忽略）');
  }
  return true;
}

export function test() {
  step('单元测试');
  if (!npm(['test'])) die('测试未通过，已中止发布');
  ok('测试通过');
}

/** 构建 + 校验 + 测试：发布前的标准前置 */
export function prepare({ withTest = true } = {}) {
  build();
  if (withTest) test();
}

/** 产物体积摘要（供 status 展示） */
export function distSummary() {
  if (!fs.existsSync(DIST)) return null;
  let bytes = 0;
  let files = 0;
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else { bytes += st.size; files++; }
    }
  };
  try {
    walk(DIST);
    const mtime = fs.statSync(path.join(DIST, 'index.html')).mtime;
    return { bytes, files, mtime };
  } catch {
    return null;
  }
}

export const humanSize = (b) =>
  b > 1024 * 1024 ? (b / 1024 / 1024).toFixed(1) + ' MB'
  : b > 1024 ? (b / 1024).toFixed(1) + ' KB'
  : b + ' B';

void execFileSync; void info; void C;
