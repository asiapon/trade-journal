#!/usr/bin/env node
/* ============================================================
   scripts/dev/gen-dict.mjs —— 重新生成 public/ 下的两份静态数据文件
   ------------------------------------------------------------
   为什么需要它：设置 → 数据管理 → 静态数据里的「刷新」按钮只能写
   localStorage / IndexedDB（浏览器沙箱不允许网页改磁盘文件），
   所以那份随应用打包的 json 快照永远不会变。要让**仓库里的文件**
   更新，得在本地跑这个脚本。

   用法：
     node scripts/dev/gen-dict.mjs            两个都刷
     node scripts/dev/gen-dict.mjs stocks     只刷股票名录
     node scripts/dev/gen-dict.mjs boards     只刷板块成分

   输出格式与现有文件逐字一致（紧凑 JSON）：
     stock-dict.json  {"v":"2026-10-20","n":5573,"d":[["000001","平安银行","payh"],...]}
     board-dict.json  {"v":"2026-10-20","n":803,"b":[["新材料",[55,60,...]],...]}

   两个数据源不同接口，所以分开刷：
     股票名录 = 东财 push2 clist 全 A 列表（约 12 页）
     板块成分 = 板块列表(2 页) + 逐板块成分股（~1000 次请求，要几分钟）

   跑完后记得重新构建（dist 里是构建时拷过去的副本）：
     node scripts/cli.mjs dev check      # 构建 + 校验 + 测试
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const STOCK_FILE = path.join(PUBLIC, 'stock-dict.json');
const BOARD_FILE = path.join(PUBLIC, 'board-dict.json');

const GAP = 40;          // 每次请求后的间隔
const CONC = 4;          // 成分股并发
const MIN_STOCKS = 1000; // 低于此值视为接口异常，拒绝覆盖（防止把好数据写成空）
const MIN_BOARDS = 100;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const HDR = { 'User-Agent': UA, 'Referer': 'https://quote.eastmoney.com/' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 接口根地址可覆盖：走代理 / 内网镜像 / 本地 mock 测试时用
   DICT_BASE=http://127.0.0.1:8899 node scripts/dev/gen-dict.mjs stocks */
const BASE = (process.env.DICT_BASE || 'https://push2.eastmoney.com').replace(/\/+$/, '');

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** 东财 clist 分页拉全：返回原始行数组 */
async function clist(fsParam, fields, label) {
  const pz = 500;
  let pn = 1;
  let total = Infinity;
  let got = 0;
  const rows = [];
  for (;;) {
    const url = BASE + '/api/qt/clist/get?pn=' + pn + '&pz=' + pz
      + '&po=1&np=1&fltt=2&invt=2&fid=f12&fs=' + encodeURIComponent(fsParam) + '&fields=' + fields;
    let d = null;
    for (let t = 0; t < 2 && !d; t++) {
      try {
        const r = await fetch(url, { headers: HDR });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        if (!j || !j.data) throw new Error('返回无 data');
        d = j.data;
      } catch (e) {
        if (t === 1) throw new Error(label + ' 第 ' + pn + ' 页失败：' + (e.message || e));
        await sleep(500);
      }
    }
    if (pn === 1) total = d.total || 0;
    const diff = d.diff || [];
    if (!diff.length) break;
    for (const r of diff) rows.push(r);
    got += diff.length;
    if (got >= total) break;
    pn++;
    await sleep(GAP);
  }
  console.log(`  ${label}：${got} 行 / ${pn} 页`);
  return rows;
}

/* ---------- 股票名录 ---------- */
async function genStocks() {
  console.log('\n▶ 股票名录（东财 push2 clist 全 A）');
  /* 旧文件用来保留拼音、以及保住新列表里没有的退市股（删了会让历史交易的名字变空） */
  const old = JSON.parse(fs.readFileSync(STOCK_FILE, 'utf8'));
  const oldMap = new Map();
  for (const r of old.d || []) {
    oldMap.set(String(r[0]).padStart(6, '0'), { name: r[1] || '', py: r[2] || '' });
  }

  const rows = await clist('m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048', 'f12,f14', '全 A 列表');
  const live = new Map();
  for (const r of rows) {
    const c = String(r.f12 || '');
    const nm = String(r.f14 || '').trim();
    if (/^\d{6}$/.test(c) && nm) live.set(c, nm);
  }
  if (live.size < MIN_STOCKS) {
    throw new Error(`只取回 ${live.size} 条（阈值 ${MIN_STOCKS}），疑似接口异常，已放弃写入`);
  }

  const next = new Map();
  for (const [c, nm] of live) {
    const o = oldMap.get(c);
    next.set(c, [c, nm, (o && o.py) || '']);
  }
  let kept = 0;
  for (const [c, o] of oldMap) {
    if (!next.has(c)) { next.set(c, [c, o.name, o.py]); kept++; }
  }

  const d = Array.from(next.values()).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const out = { v: todayStr(), n: d.length, d };
  fs.writeFileSync(STOCK_FILE, JSON.stringify(out), 'utf8');
  console.log(`  ✓ 写入 public/stock-dict.json：${live.size} 只在市 + ${kept} 只退市保留 = ${d.length} 条`);
  return { n: d.length, live: live.size, kept };
}

/* ---------- 板块成分 ---------- */
async function genBoards() {
  console.log('\n▶ 板块成分（板块列表 + 逐板块成分股，约 1000 次请求）');
  const boards = [];
  for (const [fsParam, type] of [['m:90+t:2+f:!50', '行业'], ['m:90+t:3+f:!50', '概念']]) {
    const rows = await clist(fsParam, 'f12,f14', type + '板块列表');
    for (const r of rows) {
      const bk = String(r.f12 || '');
      const nm = String(r.f14 || '').trim();
      if (/^BK\d{4,6}$/.test(bk) && nm) boards.push({ bk, name: nm });
    }
  }
  if (boards.length < MIN_BOARDS) {
    throw new Error(`板块列表只取回 ${boards.length} 个（阈值 ${MIN_BOARDS}），已放弃写入`);
  }
  console.log(`  板块总数：${boards.length}，开始拉成分股…`);

  /* 同名板块（行业/概念重名）合并到一个 Set —— 与页面里 DataHub 的口径一致 */
  const byName = new Map();
  let next = 0;
  let done = 0;
  let fail = 0;
  let streak = 0;
  let broken = null;

  const worker = async () => {
    for (;;) {
      if (broken) return;
      const i = next++;
      if (i >= boards.length) return;
      const b = boards[i];
      try {
        const url = BASE + '/api/qt/clist/get?pn=1&pz=1000&po=1&np=1'
          + '&fltt=2&invt=2&fid=f12&fs=' + encodeURIComponent('b:' + b.bk) + '&fields=f12';
        const r = await fetch(url, { headers: HDR });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        const diff = (j && j.data && j.data.diff) || [];
        if (diff.length) {
          let st = byName.get(b.name);
          if (!st) { st = new Set(); byName.set(b.name, st); }
          for (const d of diff) {
            const c = String(d.f12 || '');
            if (/^\d{6}$/.test(c)) st.add(c);
          }
        }
        streak = 0;
      } catch (e) {
        fail++;
        streak++;
        /* 连续 10 个失败 → 疑似被风控，立刻中止，别把上千个注定失败的请求打完 */
        if (streak >= 10) broken = '板块成分连续失败过多（疑似接口风控/断网），本轮中止';
      }
      done++;
      if (done % 50 === 0) process.stdout.write(`\r  进度 ${done}/${boards.length}`);
      await sleep(GAP);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONC, boards.length) }, worker));
  process.stdout.write('\r');
  if (broken) throw new Error(broken);
  if (fail > boards.length * 0.2) {
    throw new Error(`成分股失败率过高（${fail}/${boards.length}），已放弃写入`);
  }

  const b = [];
  for (const [nm, set] of byName) {
    if (set.size) b.push([nm, Array.from(set).map(Number)]);
  }
  if (b.length < MIN_BOARDS) throw new Error(`有效板块只剩 ${b.length} 个，已放弃写入`);

  const out = { v: todayStr(), n: b.length, b };
  fs.writeFileSync(BOARD_FILE, JSON.stringify(out), 'utf8');
  console.log(`  ✓ 写入 public/board-dict.json：${b.length} 个板块（失败 ${fail}）`);
  return { n: b.length, fail };
}

/* ---------- 入口 ---------- */
const arg = (process.argv[2] || 'all').toLowerCase();
const wantStocks = arg === 'all' || arg === 'stocks' || arg === 'stock';
const wantBoards = arg === 'all' || arg === 'boards' || arg === 'board';

if (!wantStocks && !wantBoards) {
  console.error('用法：node scripts/dev/gen-dict.mjs [all|stocks|boards]');
  process.exit(1);
}

console.log('重新生成静态数据文件（数据源：东财免费公开接口，无需 Key）');
const t0 = Date.now();
try {
  if (wantStocks) await genStocks();
  if (wantBoards) await genBoards();
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n完成，用时 ${sec}s。`);
  console.log('下一步：node scripts/cli.mjs dev check    # 重新构建，把新文件带进 dist/');
} catch (e) {
  console.error('\n✗ 失败：' + (e.message || e));
  console.error('  文件未被修改（写入前会先校验条数阈值）。');
  process.exit(1);
}
