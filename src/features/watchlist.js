/* 自选域：分组 / 排序 / 卡片与弹窗（v0.11.0 自单体拆出） */
import { $, toast, fmt2, fmtP, fmtPct, pnlCls, esc, fmtTime, nowLocalInput, inferMarket, MKT_NAME } from '../shared/utils.js';
import { NetLog, sjTokenHeaders } from '../core/netlog.js';
import { StockDict } from '../core/stockdict.js';
import { DL } from '../core/data-layer.js';
import { emQuote, txQuote } from '../sources/quotes.js';
import { ACCESS_KEY, BACKEND_URL, CLOUD_HOST, RPC_BASE, TABLES, cloudStore, loadAll, localStore, rpc, saveSetting, sessionHooks, setStore, storageHooks, store } from '../storage/gateway.js';
import { S } from '../core/app-state.js';
import { U } from '../core/ui-state.js';
import { ICO } from '../app.js';
import { quoteMap, scrollRecBottom } from './journal.js';
import { WATCH_MOUNTS, renderToday } from './overview.js';
import { NetQuote, refreshQuotes } from './quotes.js';
import { bindSuggest, confirmDlg, promptDlg } from '../ui/widgets.js';

export let watchTab = (() => { try { return localStorage.getItem('sj_watchTab') || '默认'; } catch (e) { return '默认'; } })();   // 当前分组 Tab（记住上次所在分组）
/* v3.8.50 分组名单独持久化：此前分组只能从 watchlist 的 group_name 反推，
   于是「新建了分组但里面还没有股票」→ 一刷新分组就消失，用起来很别扭。
   现在把分组名记进 localStorage，空分组也一直显示。 */
export let watchGroups = (() => {
  try {
    const a = JSON.parse(localStorage.getItem('sj_groups') || '[]');
    return Array.isArray(a) ? a.filter(x => typeof x === 'string' && x && x !== '默认') : [];
  } catch (e) { return []; }
})();
export function saveWatchGroups() { try { localStorage.setItem('sj_groups', JSON.stringify(watchGroups)); } catch (e) { /* */ } }
export function addWatchGroup(name) {
  name = (name || '').trim();
  if (!name || name === '默认' || watchGroups.includes(name)) return;
  watchGroups.push(name); saveWatchGroups();
}
export function removeWatchGroup(name) {
  const i = watchGroups.indexOf(name);
  if (i >= 0) { watchGroups.splice(i, 1); saveWatchGroups(); }
}
/* 全部已存在的分组：默认 + 持久化的空分组 + 自选里实际用到的分组 */
export function allWatchGroups() {
  return [...new Set(['默认', ...watchGroups, ...S.watchlist.map(w => w.group_name || '默认')])].filter(Boolean);
}
/* v3.8.22 自选表表头排序状态：dir 1=降序(第一次点击) / -1=升序 / 0=未排序 */
export let watchSort = { key: null, dir: 0 };
/* v3.8.23 持仓表同款三态排序（自选功能复制试点） */
export function updateSortHead(tableSel, state) {
  /* v3.8.34 支持一次更新多处同源表格（持仓页/总览页共用一份数据） */
  const sels = Array.isArray(tableSel) ? tableSel : [tableSel];
  for (const sel of sels) document.querySelectorAll(sel + ' th.sortable').forEach(th => {
    th.classList.toggle('sorted-desc', state.key === th.dataset.sort && state.dir === 1);
    th.classList.toggle('sorted-asc', state.key === th.dataset.sort && state.dir === -1);
  });
}
export function updateWatchHead() { updateSortHead('#tvWatchTable', watchSort); }
/* 自选数据模型：分组 Tab + 行数据（含排序），与挂载点无关 */
export function watchModel() {
  const groups = allWatchGroups();
  const tabGroups = groups.includes(watchTab) ? groups : [...groups, watchTab].filter(Boolean);
  const list = S.watchlist.filter(w => !watchTab || (w.group_name || '默认') === watchTab);
  const qm = quoteMap();
  /* v3.8.83 分组统计：数量 + 组内涨跌幅平均值（跳过未知涨跌幅的票）。
     例：组内 5 只、只有 4 只有涨跌幅 → 用这 4 只的平均值代表该组涨跌幅；
     全组都没有涨跌幅（行情未到）→ avgChg 为 null，Tab 上不显示涨幅。 */
  const groupStat = new Map();
  for (const g of tabGroups) {
    const inG = S.watchlist.filter(w => (w.group_name || '默认') === g);
    let sum = 0, cnt = 0;
    for (const w of inG) {
      const q = qm.get(w.stock_code);
      if (q && q.pct != null && !isNaN(q.pct)) { sum += Number(q.pct); cnt++; }
    }
    groupStat.set(g, { count: inG.length, avgChg: cnt ? sum / cnt : null, known: cnt });
  }
  const backfilled = new Set();   // 本轮渲染中已触发锚点回填的自选 id
  /* v3.8.22 先算每行的展示数据，再按表头排序状态排序 */
  const items = list.map(w => {
    const q = qm.get(w.stock_code);
    const price = q ? q.price : null;                       // 网络现价
    const chg = q && q.pct != null && !isNaN(q.pct) ? q.pct / 100 : null;
    /* 自选收益：现价 vs 添加/手填时的价格锚点（cur_price） */
    let anchor = w.cur_price != null ? Number(w.cur_price) : null;
    /* 锚点缺失（加自选时行情未取到）→ 首次拿到行情时用最新价回填入库 */
    if (anchor == null && price != null && w.id != null && !backfilled.has(w.id)) {
      backfilled.add(w.id);
      store.update('watchlist', w.id, { cur_price: price }).catch(() => backfilled.delete(w.id));
      anchor = price;   // 本次渲染先用最新价展示
    }
    const gain = price != null && anchor ? (price - anchor) / anchor : null;
    const d = w.created_at ? new Date(w.created_at) : null;
    const addDate = d && !isNaN(d) ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '—';
    return { w, q, price, chg, anchor, gain, addDate, ts: d && !isNaN(d) ? d.getTime() : null };
  });
  if (watchSort.key && watchSort.dir) {
    const getter = {
      price: it => it.price, chg: it => it.chg,
      open: it => it.q && it.q.open != null ? it.q.open : null,
      high: it => it.q && it.q.high != null ? it.q.high : null,
      low: it => it.q && it.q.low != null ? it.q.low : null,
      prevClose: it => it.q && it.q.prevClose != null ? it.q.prevClose : null,
      date: it => it.ts, anchor: it => it.anchor, gain: it => it.gain
    }[watchSort.key];
    if (getter) {
      items.sort((a, b) => {
        const va = getter(a), vb = getter(b);
        if (va == null && vb == null) return 0;
        if (va == null) return 1;    // 空值恒排最后
        if (vb == null) return -1;
        return (vb - va) * watchSort.dir;   // dir=1 降序优先，dir=-1 升序
      });
    }
  }
  return { tabGroups, items, listLen: list.length, groupStat };
}
/* v3.8.34 把自选列表画到某个挂载点（总览页 / 自选页共用同一份模型） */
export function paintWatch(m, M) {
  const el = id => document.getElementById(id);
  const tabs = el(m.tabs);
  /* v3.8.45 分组行结构：左侧是「内容」（分组 Tab），右侧是两个「动作」按钮
     = 图标 + 短词（folderPlus「新建分组」/ trash「删除分组」），样式上与 Tab 分层。
     删除按钮仅在具体分组（非「默认」）时出现。 */
  const canDelGroup = !!(watchTab && watchTab !== '默认');
  if (tabs) {
    /* v3.8.83 分组 Tab 增加「组内涨跌幅平均值」：数量徽标保留，后面跟一个涨跌胶囊。
       跳过未知涨跌幅的票（组内 5 只只有 4 只有值 → 取这 4 只的平均）；全组无值则不显示。
       涨幅配色沿用全局 pnlCls（红涨绿跌，A 股习惯）。 */
    tabs.innerHTML = M.tabGroups.map(g => {
      const st = (M.groupStat && M.groupStat.get(g)) || { count: 0, avgChg: null };
      const avg = st.avgChg != null
        ? `<em class="wtab-chg ${pnlCls(st.avgChg / 100)}">${fmtPct(st.avgChg / 100)}</em>`
        : '';
      return `<button class="wtab${watchTab === g ? ' on' : ''}" data-g="${esc(g)}">${esc(g)}<i>${st.count}</i>${avg}</button>`;
    }).join('')
      + `<button class="wtab wtab-act wtab-add" data-g="+" title="新建分组" aria-label="新建分组">${ICO.folderPlus}<span>新建分组</span></button>`
      + (m.delGroup ? `<button class="wtab wtab-act wtab-del" id="${m.delGroup}" type="button" aria-label="删除当前分组" title="删除当前分组，组内自选移回「默认」"${canDelGroup ? '' : ' hidden'}>${ICO.trash}<span>删除分组</span></button>` : '');
  }
  const table = el(m.table);
  if (!table) return;                       // 该挂载点不存在（例如页面已下线）
  const empty = el(m.empty);
  const FAIL = '<span class="na-tag">获取失败</span>';
  table.querySelector('tbody').innerHTML = M.items.map(({ w, q, price, chg, anchor, gain, addDate }) => {
    return `<tr data-id="${w.id}">
      <td><div class="stock-cell"><span class="sc-name">${esc(w.stock_name || '')}</span><span class="sc-code">${esc(w.stock_code)}</span></div></td>
      <td class="num">${price != null ? fmt2(price) : FAIL}</td>
      <td class="num ${chg != null ? pnlCls(chg) : ''}">${chg != null ? fmtPct(chg) : FAIL}</td>
      <td class="num">${q && q.open != null ? fmt2(q.open) : '—'}</td>
      <td class="num">${q && q.high != null ? fmt2(q.high) : '—'}</td>
      <td class="num">${q && q.low != null ? fmt2(q.low) : '—'}</td>
      <td class="num">${q && q.prevClose != null ? fmt2(q.prevClose) : '—'}</td>
      <td class="num hint adate">${addDate}</td>
      <td class="num">${anchor != null ? fmtP(anchor) : '—'}</td>
      <td class="num ${gain != null ? pnlCls(gain) : ''}">${gain != null ? fmtPct(gain) : '—'}</td>
      <td class="hint">${esc(w.note || '')}</td>
      <td><div class="row-actions">
        <button class="icon-btn edit-watch" data-id="${w.id}">编辑</button>
        <button class="icon-btn del del-watch" data-id="${w.id}">删除</button>
      </div></td>
    </tr>`;
  }).join('');
  if (empty) {
    empty.hidden = M.listLen > 0;
    /* v3.8.50 空态文案带可点的「＋ 加自选」链接：点它直接展开上方添加区 */
    const g = watchTab || '默认';
    empty.innerHTML = `分组「${esc(g)}」暂无自选，点<a href="javascript:void(0)" class="we-add">「＋ 加自选」</a>添加股票`;
  }
}
export function renderWatch() {
  const M = watchModel();
  for (const m of WATCH_MOUNTS) paintWatch(m, M);
  // 分组 datalist 由 syncGroupList() 统一维护
  syncGroupList();
  updateWatchHead();
}
/* 分组下拉数据源（v3.8.82 起为自绘 .wg-list，原 datalist 已删除）：
   所有已用分组 + 当前分组（数据加载完即同步） */
export function syncGroupList() {
  const groups = [...new Set([...allWatchGroups(), watchTab])].filter(Boolean);
  const dl = $('tvWfGroupList');
  if (dl) dl.innerHTML = groups.length
    ? groups.map(g => `<div class="wg-item${g === watchTab ? ' on' : ''}" data-g="${esc(g)}">${esc(g)}</div>`).join('')
    : '<div class="wg-empty">暂无分组，可直接输入新分组名</div>';
}
/* ============================================================
   v3.8.78 加自选改为「弹窗」（与「＋ 记一笔」同一交互模式）

   旧做法（v3.8.39~v3.8.77）：标题行「＋ 加自选」按钮在原地**展开**表单
   （.watch-form.open），再靠一整套 revealWatchForm 逻辑在手机键盘弹起后
   把表单滚进可视区 —— 需要 visualViewport 监听、body 补底部留白、多次定时补算，
   代码量大且仍会闪。改为弹窗后，遮罩层天然居中在键盘之上，这套滚动补偿
   逻辑整段不再需要（保留 v3.8.47 的函数仅供历史参考已删除）。

   交互对齐「记一笔」：
     · 点「＋ 加自选」→ 开弹窗（新增态，清空表单）
     · 点行内「编辑」→ 开弹窗并回填（票锁定，只改分组/理由）
     · 提交成功 / 取消 / 点遮罩 / 按 Esc → 关弹窗
   ============================================================ */
export function openWatchModal(reset = true) {
  const m = document.getElementById('watchModal');
  if (!m) return;
  if (reset) resetWatchForm(false);            // 清空表单，但先不关弹窗（由下面统一控制）
  m.hidden = false;
  fitWatchModal();                             // v3.8.79 打开即按当前可视视口校准高度
  /* v3.8.79 焦点策略（修「输完光标自动下一个文本框」）：
     只有「用户显式点了我」才自动送光标 —— 点标题栏「＋ 加自选」或空态链接进来时，
     直接给股票框聚焦，省一次点击；从行内「编辑」进来时股票框已只读，光标给备注框。
     键盘 / 按钮触发（relatedTarget 为 null）时不再自动聚焦，避免手机上刚一点开
     就弹键盘、把下面的按钮顶出屏幕外。 */
  const target = watchFocusTarget();
  if (target) setTimeout(() => { try { target.focus({ preventScroll: true }); } catch (e) { try { target.focus(); } catch (e2) { /* */ } } }, 60);
}
/* v3.8.79 弹窗打开后「光标该落在哪」：编辑态（股票框只读）→ 备注框；新增态 → 股票框 */
export function watchFocusTarget() {
  const inp = document.getElementById('tvWfInput');
  const note = document.getElementById('tvWfNoteQuick');
  if (!inp) return note || null;
  return (inp.readOnly && note) ? note : inp;
}
export function closeWatchModal() {
  const m = document.getElementById('watchModal');
  if (!m) return;
  m.hidden = true;
  const lg = m.querySelector('.modal-lg');
  if (lg) lg.style.maxHeight = '';             // v3.8.79 清掉键盘适配留下的内联高度
  resetWatchForm(false);                       // 关闭即复位（等同取消），不留半截输入
  const sb = document.getElementById('tvWfSug'); if (sb) sb.hidden = true;
  const gl = document.getElementById('tvWfGroupList'); if (gl) gl.hidden = true;   // v3.8.82 分组下拉一并收起
}
/* v3.8.79 加自选弹窗高度跟随可视视口
   —— 与「记一笔」的 scrollRecBottom/fit 同一套思路，但独立实现（两边弹窗高度策略不同：
   记一笔是「滚到底部」，加自选只需保证整窗不被键盘遮住）。
   窄屏时 .modal-lg 的 max-height 由 JS 写内联值（压过 CSS 的 88vh）；
   宽屏沿用 CSS，避免桌面档被多余地限制。
   注意：只有「可视视口比 layout 视口明显缩水（>60px，即键盘弹起的量级）」才跟随，
   否则用 innerHeight —— 地址栏伸缩 / 平板分屏也会让 vv.height 偏小，
   不设阈值的话弹窗会被无谓压扁（headless 截图已复现过这个误判）。 */
export function fitWatchModal() {
  const m = document.getElementById('watchModal');
  if (!m || m.hidden) return;
  const lg = m.querySelector('.modal-lg');
  if (!lg) return;
  const vv = window.visualViewport;
  const narrow = window.matchMedia('(max-width: 639px)').matches;
  if (narrow) {
    let vh = window.innerHeight;
    if (vv && vv.height > 0 && window.innerHeight - vv.height > 60) vh = vv.height;
    /* v3.8.82 留白 100px：CSS 里 #watchModal 窄屏内距「上 10 下 90」（累计上移 40px），
       这里保持一致，弹窗才不会顶出视口。 */
    lg.style.maxHeight = Math.max(200, Math.round(vh - 100)) + 'px';
  } else {
    lg.style.maxHeight = '';                   // 宽屏交回 CSS（88vh）
  }
}
(function () {
  const vv = window.visualViewport;
  if (!vv) return;
  let t = null;
  const sync = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      fitWatchModal();
      /* v3.8.79 键盘高度写进 :root 的 --kb，供 style.css 里 #watchModal .modal-lg 的
         max-height 计算兜底（老浏览器没有 dvh 时靠它）。
         同 fitWatchModal：只有缩水超过 60px（键盘量级）才认，否则归 0。
         v3.8.84 顺带在 <html> 上挂 .kb-on：键盘真的弹起时收窄弹窗内下拉的高度
         （分组下拉 / 股票联想 200px 在键盘场景会整条压进键盘底下），见 style.css。 */
      const shrink = window.innerHeight - vv.height - vv.offsetTop;
      const kbOn = shrink > 60;
      document.documentElement.style.setProperty('--kb', kbOn ? Math.round(shrink) + 'px' : '0px');
      document.documentElement.classList.toggle('kb-on', kbOn);
      /* v3.8.84 「电脑端选分组时弹窗标题没了」的修复：
         旧写法只要 vv 触发 scroll/resize（电脑上**滚动页面就会触发**）就对聚焦控件
         scrollIntoView —— scrollIntoView 会连弹窗这个可滚祖先一起滚，把标题+股票框
         滚出弹窗可视区。现在只在「窄屏 + 键盘真的弹起」时才滚（那是它唯一该出场
         的场景：键盘弹起后聚焦框可能被压在键盘底下）。 */
      const m = $('watchModal');
      if (kbOn && window.matchMedia('(max-width: 639px)').matches && m && !m.hidden) {
        const el = document.activeElement;
        if (el && el !== document.body && m.contains(el) &&
            /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) {
          try { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { /* */ }
        }
      }
    }, 80);
  };
  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
})();
/* 兼容旧调用点：setWatchFormOpen(m, true/false) 现等价于「开/关弹窗」。
   保留这个函数名，是为了让 bindWatchCard 里的调用点不必全改。 */
export function setWatchFormOpen(m, open) {
  if (open) openWatchModal(false);
  else closeWatchModal();
}

export function fillWatchForm(w, m) {
  resetWatchForm();                          // 先清空所有挂载点，避免两个表单同时停在编辑态
  S.editingWatchId = w.id;
  const inp = document.getElementById(m.input);
  if (!inp) return;
  inp.value = `${w.stock_code} ${w.stock_name || ''}`;
  delete inp.dataset.picked;
  inp.readOnly = true;                       // 编辑时票不可改，只能改分组/理由
  inp.placeholder = '编辑中：股票不可修改';
  inp.classList.add('ro');
  const gq = document.getElementById(m.group); if (gq) gq.value = w.group_name || '默认';
  const nt = document.getElementById(m.note); if (nt) nt.value = w.note || '';
  const sub = document.getElementById(m.submit); if (sub) sub.textContent = '保存';   /* v3.8.35 编辑态：保存 */
  const cc = document.getElementById(m.cancel); if (cc) cc.hidden = false;
  /* v3.8.78 弹窗标题跟着态变：编辑 → 「编辑自选」 */
  const tt = $('watchModalTitle'); if (tt) tt.textContent = '编辑自选';
  /* v3.8.78 编辑：开弹窗并回填（不再原地展开）。传 reset=false 保留刚填的值 */
  openWatchModal(false);
}
/* v3.8.78 表单复位。参数已无意义（表单不再「展开/收起」，只是弹窗里的内容），
   保留形参是为了不破坏既有调用点；关弹窗由 closeWatchModal() 负责。 */
export function resetWatchForm() {
  S.editingWatchId = null;
  /* v3.8.78 标题回到「加自选」（新增态） */
  const wt = document.getElementById('watchModalTitle'); if (wt) wt.textContent = '加自选';
  /* v3.8.34 所有挂载点一并复位 */
  for (const m of WATCH_MOUNTS) {
    const form = document.getElementById(m.form); if (form) form.reset();
    const inp = document.getElementById(m.input);
    if (inp) {
      inp.value = ''; delete inp.dataset.picked;
      inp.readOnly = false;
      inp.placeholder = '代码 / 名称 / 拼音首字母，如 600519、贵州茅台、gzmt';
      inp.classList.remove('ro');
    }
    /* v3.8.86 分组框默认填「当前选中的分组 Tab」。
       旧写法 `gq.value = ''` 每次打开都是空框，用户在「自选 A」组里点加自选，
       还得再手敲一遍分组名 —— 而绝大多数场景就是「加到我现在看的这个组」。
       这里只在新增态（resetWatchForm 仅由 reset=true 的 openWatchModal 调用）填默认值；
       编辑态走 openWatchModal(false)，不经过本函数，稍后由 fillWatchForm 用行内原值覆盖。
       注意：watchTab 是「当前 Tab」，不是「分组是否存在」——极端情况下 Tab 名可能不在
       分组列表里，但提交时后端按字符串存，不影响。 */
    const gq = document.getElementById(m.group);
    if (gq) gq.value = watchTab || '默认';
    const nt = document.getElementById(m.note); if (nt) nt.value = '';
    const sub = document.getElementById(m.submit); if (sub) sub.textContent = '添加';   /* v3.8.35 新增态：添加 */
    const cc = document.getElementById(m.cancel); if (cc) cc.hidden = true;
  }
}
/* ============================================================
   v3.8.34 为一个「自选卡片」挂载点绑定全部交互
   —— 总览页 / 自选页共用同一实现，后续下线某个页面只需移除挂载点
   ============================================================ */
export function bindWatchCard(m) {
  const el = id => document.getElementById(id);
  const input = el(m.input);
  if (!input) return false;                    // 该挂载点不存在（页面已下线）
  bindSuggest(m.input, m.sug, h => {
    input.value = `${h.code} ${h.name}`;
    input.dataset.picked = h.code;
    /* v3.8.79 去掉「选完股票光标自动跳备注框」。旧写法无论用户下一步想干嘛都强行
       focus 到备注框，手机上等于「选完立刻弹一次键盘」，用户反馈不想要这个跳转。
       现在只改写 input 自身的 value，光标停在原地 —— 想接着填备注，点一下即可。 */
  });
  /* v3.8.82 分组下拉：原生 datalist 的弹层宽度由浏览器决定（PC 上能铺满半个弹窗），
     无法用 CSS 约束，改为自绘 .wg-list —— 与输入框同宽，聚焦展开、点选填入、
     点击外部 / Esc / 失焦收起；输入框仍可自由输入新分组名（不再聚焦清空）。 */
  const gq = el(m.group);
  if (gq) {
    const gList = document.getElementById('tvWfGroupList');
    const closeGList = () => { if (gList) gList.hidden = true; };
    if (gList) {
      const openGList = () => {
        syncGroupList();
        gList.hidden = false;
        /* v3.8.84 保险：弹窗内容并不需要滚动时（PC 上内容远小于 max-height），
           把可能被误滚的 scrollTop 复位回 0，保证「加自选」标题始终可见。 */
        const lg = gList.closest('.modal-lg');
        if (lg && lg.scrollHeight <= lg.clientHeight + 2 && lg.scrollTop > 0) lg.scrollTop = 0;
      };
      gq.addEventListener('focus', openGList);
      gq.addEventListener('input', openGList);          // 输入中也保持展开（可边输边点选）
      gq.addEventListener('blur', () => setTimeout(closeGList, 150));
      gq.addEventListener('keydown', e => { if (e.key === 'Escape') closeGList(); });
      gList.addEventListener('mousedown', e => {        // mousedown 抢在 blur 前完成点选
        const it = e.target.closest('.wg-item');
        if (!it) return;
        e.preventDefault();
        gq.value = it.dataset.g;
        closeGList();
      });
    }
  }
  /* 提交：编辑（票已定，只改理由/分组，可手动改）或新增 */
  el(m.form).addEventListener('submit', async e => {
    e.preventDefault();
    const noteEl = el(m.note), groupEl = el(m.group);
    const note = noteEl ? noteEl.value.trim() : '';
    const group = (groupEl ? groupEl.value.trim() : '') || watchTab || '默认';
    if (S.editingWatchId) {
      const w = S.watchlist.find(x => x.id == S.editingWatchId);
      if (!w) { resetWatchForm(); return; }
      /* v3.8.83 编辑（改分组）也要防重：同一分组里不允许出现重复标的（跨分组允许）。
         排除自己这条（w.id），把票挪进已含有该票的分组时直接拦下。 */
      if ((w.group_name || '默认') !== group) {
        const dup = S.watchlist.find(x => x.id != w.id &&
          x.stock_code === w.stock_code && (x.group_name || '默认') === group);
        if (dup) { toast(`${w.stock_name || w.stock_code} 已在「${group}」分组中，换个分组即可`, 'warn'); return; }
      }
      try {
        await store.update('watchlist', w.id, { group_name: group, note });
        await store.log('watch', `修改自选 ${w.stock_name || w.stock_code}（理由/分组）`);
        addWatchGroup(group);                // v3.8.50 用到的分组名一并记住
        toast('已保存');
        closeWatchModal();                   // v3.8.78 保存成功即关弹窗
        watchTab = group; try { localStorage.setItem('sj_watchTab', group); } catch (err) { /* */ }
        await loadAll(); renderWatch(); renderToday();
      } catch (err) { toast(err.message || '保存失败', 'warn'); }
      return;
    }
    /* 添加：联想命中 / 「代码 名称」/ 纯代码 / 名称拼音 */
    const picked = input.dataset.picked;
    const txt = input.value.trim();
    let hit = null;
    if (picked && txt.startsWith(picked)) hit = { code: picked, name: txt.slice(picked.length).trim() };
    else hit = StockDict.resolve(txt);
    if (!hit || !hit.code) { toast('未识别股票，请输入代码或名称', 'warn'); return; }
    if (!hit.name) hit.name = hit.code;
    /* v3.8.83 同分组去重：同一分组内不允许重复标的，跨分组可以各加一份
       （例如「600519 贵州茅台」同时进「白酒」和「核心持仓」）。
       旧行为是「全局只要存在就拒绝」（见 addQuick 里的 some 判断），
       导致无法把同一只票放进第二个分组。
       v3.8.85 提示语写清「换个分组就行」，避免用户误以为整只票加不进来。 */
    const dup = S.watchlist.find(x => x.stock_code === hit.code && (x.group_name || '默认') === group);
    if (dup) { toast(`${hit.name || hit.code} 已在「${group}」分组中，换个分组即可再添加`, 'warn'); return; }
    /* 添加时记一个现价锚点（供「自选收益」计算）；网络行情没有则留空 */
    let anchor = NetQuote.get(hit.code);
    if (!anchor) { try { await refreshQuotes(true); } catch (err) { /* */ } anchor = NetQuote.get(hit.code); }
    const row = {
      stock_code: hit.code,
      stock_name: hit.name,
      /* v3.8.85 分组名一律落库为非空字符串：DB 唯一约束是 (owner_id, stock_code, group_name)，
         而 SQL 里 NULL 互不相等，一旦写入 NULL 就等于绕过约束（同组能塞两条）。
         这里统一兜到「默认」，配合约束上的 NULLS NOT DISTINCT 双保险。 */
      group_name: group || '默认',
      note, cur_price: anchor ? anchor.price : null, prev_close: null
    };
    try {
      await store.insert('watchlist', row);
      await store.log('watch', `添加自选 ${row.stock_name}（${row.stock_code}）`);
      addWatchGroup(group);                  // v3.8.50 用到的分组名一并记住
      toast(`已添加自选 ${row.stock_name}`);
      closeWatchModal();                     // v3.8.78 添加成功即关弹窗
      watchTab = group; try { localStorage.setItem('sj_watchTab', group); } catch (err) { /* */ }
      await loadAll(); renderWatch(); renderToday();
    } catch (err) { toast(err.message || '保存失败', 'warn'); }
  });
  const cancelBtn = el(m.cancel);
  if (cancelBtn) cancelBtn.addEventListener('click', () => closeWatchModal());
  /* v3.8.50 空态里的「＋ 加自选」链接（内容随渲染重建，故用事件委托） */
  const emptyEl = el(m.empty);
  if (emptyEl) emptyEl.addEventListener('click', e => {
    if (e.target.closest('.we-add')) openWatchModal(true);
  });  /* v3.8.78 标题行「＋ 加自选」：开弹窗（新增态）。旧版是原地展开/收起切换，
     现在只有「开」这一个动作 —— 关闭交给弹窗自己的 ✕ / 取消 / 遮罩 / Esc */
  const toggleBtn = m.toggle ? el(m.toggle) : null;
  if (toggleBtn) toggleBtn.addEventListener('click', () => {
    openWatchModal(true);
    /* v3.8.79 只在**用户手动点击**（relatedTarget 为 null，即指针/触摸触发）时自动把
       光标送进股票框。键盘 Enter 激活按钮（relatedTarget 是按钮本身）时不抢焦点，
       否则会绕过 openWatchModal 里的「不自动聚焦」策略。 */
    const rt = window.event && window.event.relatedTarget;
    if (rt == null) {
      const t = watchFocusTarget();
      if (t) setTimeout(() => { try { t.focus({ preventScroll: true }); } catch (e) { /* */ } }, 80);
    }
  });
  /* v3.8.41 「删除该分组」按钮也渲染在分组 Tab 行内，走同一处事件委托 */
  const tabs = el(m.tabs);
  if (tabs) tabs.addEventListener('click', e => {
    const b = e.target.closest('.wtab'); if (!b) return;
    /* v3.8.50 只要是「处理分组」（切换 / 新建 / 删除），先把上面的添加区收起来，
       避免分组变了、添加区还停在上一次的半截输入上 */
    resetWatchForm();
    if (b.classList.contains('wtab-del')) { delWatchGroup(); return; }
    const g = b.dataset.g;
    if (g === '+') {
      /* v3.8.43 新建分组改用与「删除该分组」同款的自定义弹窗（原为浏览器原生 prompt） */
      promptDlg('新建分组', '输入新分组名称，确认后自动切到该分组。', name => {
        name = (name || '').trim();
        if (!name) return;
        addWatchGroup(name);                 // v3.8.50 落盘：空分组也要一直显示
        watchTab = name;
        try { localStorage.setItem('sj_watchTab', watchTab); } catch (err) { /* */ }
        renderWatch();
        const gqEl = el(m.group); if (gqEl) gqEl.value = name;
      }, { okText: '新建', placeholder: '如：白酒 / 新能源' });
      return;
    }
    watchTab = g;
    try { localStorage.setItem('sj_watchTab', watchTab); } catch (err) { /* */ }
    renderWatch();
    const gqEl = el(m.group); if (gqEl) gqEl.value = g || '';   // 当前分组即默认归组，可手动改
  });
  const table = el(m.table);
  /* v3.8.22 表头排序：点一下降序 → 再点升序 → 再点取消 */
  table.querySelector('thead').addEventListener('click', e => {
    const th = e.target.closest('th.sortable'); if (!th) return;
    const k = th.dataset.sort;
    if (watchSort.key !== k) watchSort = { key: k, dir: 1 };
    else if (watchSort.dir === 1) watchSort = { key: k, dir: -1 };
    else watchSort = { key: null, dir: 0 };
    renderWatch();
  });
  /* 行操作：编辑（回填到本卡表单） / 删除 */
  table.querySelector('tbody').addEventListener('click', async e => {
    const editBtn = e.target.closest('.edit-watch');
    const delBtn = e.target.closest('.del-watch');
    if (editBtn) {
      const w = S.watchlist.find(x => x.id == editBtn.dataset.id);
      if (w) {
        /* v3.8.78 改为弹窗后不再需要把表单滚进视野（弹窗自带居中），
           fillWatchForm 内部已调用 openWatchModal() */
        fillWatchForm(w, m);
      }
      return;
    }
    if (delBtn) {
      const w = S.watchlist.find(x => x.id == delBtn.dataset.id);
      confirmDlg('删除自选', `确认从自选中删除 ${w.stock_name || w.stock_code}？`, async () => {
        try {
          await store.remove('watchlist', w.id);
          await store.log('delete', `删除自选 ${w.stock_name || w.stock_code}`);
          await loadAll(); renderWatch(); renderToday();
          toast('已删除');
        } catch (err) { toast(err.message || '删除失败', 'warn'); }
      });
    }
  });
  return true;
}

/* v3.8.41 删除当前分组：组内股票移回「默认」
   （按钮渲染在分组 Tab 行的「＋ 新建分组」之后，由 bindWatchCard 的事件委托触发） */
export function delWatchGroup() {
  if (!watchTab || watchTab === '默认') return;
  const g = watchTab;
  const n = S.watchlist.filter(w => (w.group_name || '默认') === g).length;
  confirmDlg('删除分组', `确认删除分组「${g}」？${n ? `组内 ${n} 只自选将移回「默认」分组` : '该分组当前为空'}。`, async () => {
    try {
      /* v3.9.11 移回「默认」前先查重：默认组里已有同代码的票时不再 update（否则默认组出现重复行），
         直接删掉本行完成去重 —— 去重由删除逻辑自己消化，全程静默不报错。 */
      const moved = new Set(); let dupN = 0;
      for (const w of S.watchlist.filter(w => (w.group_name || '默认') === g)) {
        const dup = moved.has(w.stock_code)
          || S.watchlist.some(o => o.id !== w.id && o.stock_code === w.stock_code && (o.group_name || '默认') === '默认');
        if (dup) { dupN++; await store.remove('watchlist', w.id); }
        else { moved.add(w.stock_code); await store.update('watchlist', w.id, { group_name: '默认' }); }
      }
      await store.log('update', `删除分组「${g}」（${moved.size} 只移回默认${dupN ? `，${dupN} 只与默认组重复已去重` : ''}）`);
      removeWatchGroup(g);                 // v3.8.50 从持久化分组里移除
      watchTab = '默认';
      try { localStorage.setItem('sj_watchTab', watchTab); } catch (err) { /* */ }
      resetWatchForm();
      await loadAll(); renderWatch(); renderToday();
      toast('分组已删除');
    } catch (err) { toast(err.message || '删除失败', 'warn'); }
  }, '删除');
}

/* ---------- 我的 ---------- */