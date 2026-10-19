/* UI 微件：输入联想 + 确认/输入弹窗（v0.11.0 自单体拆出） */
import { $, toast, fmt2, fmtP, fmtPct, pnlCls, esc, fmtTime, nowLocalInput, inferMarket, MKT_NAME } from '../shared/utils.js';
import { NetLog, sjTokenHeaders } from '../core/netlog.js';
import { StockDict } from '../core/stockdict.js';
import { DL } from '../core/data-layer.js';
import { emQuote, txQuote } from '../sources/quotes.js';
import { TABLES, BACKEND_URL, RPC_BASE, ACCESS_KEY, CLOUD_HOST, rpc, cloudStore, localStore, setStore, loadAll, saveSetting, sessionHooks, storageHooks } from '../storage/gateway.js';
import { S } from '../core/app-state.js';

export const SUG_OFF_IN_WATCH_PC = (() => {
  let mql = null;
  try { mql = window.matchMedia('(min-width: 721px)'); } catch (e) { /* 老浏览器忽略 */ }
  return boxId => {
    if (boxId !== 'tvWfSug') return false;
    return !!(mql && mql.matches);
  };
})();

export function bindSuggest(inputId, boxId, onPick) {
  const inp = $(inputId), box = $(boxId);
  let items = [], shield = null, shieldTimer = null;
  /* 候选打开期间的透明防护罩：第一次点空白处只收起下拉，避免误触下方按钮；
     收起后延迟 350ms 再撤罩，吞掉选中后浏览器补发的 click，防止落到下方按钮上 */
  const removeShieldNow = () => {
    if (shieldTimer) { clearTimeout(shieldTimer); shieldTimer = null; }
    if (shield) { shield.remove(); shield = null; }
  };
  const showShield = () => {
    if (SUG_OFF_IN_WATCH_PC(boxId)) return;   /* v3.8.86 PC 弹窗内联想已关，别插罩拦点击 */
    if (shield) { if (shieldTimer) { clearTimeout(shieldTimer); shieldTimer = null; } return; }
    shield = document.createElement('div');
    shield.className = 'sug-shield';
    const stop = e => { e.preventDefault(); e.stopPropagation(); close(); };
    shield.addEventListener('pointerdown', stop);
    shield.addEventListener('touchstart', stop, { passive: false });
    (box.closest('.modal-mask') || document.body).appendChild(shield);
  };
  const close = () => {
    box.hidden = true; box.innerHTML = ''; items = [];
    if (shield && !shieldTimer) shieldTimer = setTimeout(removeShieldNow, 350);
  };
  inp.addEventListener('input', () => {
    /* v3.8.86 PC 弹窗内直接不渲染候选（顺手把可能残留的下拉/防护罩收掉），
       输入框本身仍照常收字符，提交走 StockDict.resolve 不受影响。 */
    if (SUG_OFF_IN_WATCH_PC(boxId)) { close(); removeShieldNow(); return; }
    const v = inp.value.trim();
    if (!v || !StockDict.ready) { close(); return; }
    items = StockDict.search(v, 8);
    if (!items.length) {
      box.innerHTML = '<div class="sug-empty">无匹配结果，可直接手动录入</div>';
      box.hidden = false;
      showShield();
      return;
    }
    box.innerHTML = items.map(h =>
      `<div class="sug-item" data-code="${esc(h.code)}" data-name="${esc(h.name)}" data-mkt="${esc(h.mkt)}"><b>${esc(h.code)}</b>${esc(h.name)}<span>${esc(MKT_NAME[h.mkt] || '')}</span></div>`
    ).join('');
    box.hidden = false;
    showShield();
    /* v3.8.79 下拉不再整块 scrollIntoView。
       旧写法 `box.scrollIntoView({block:'nearest'})` 在弹窗（.modal-lg 自身可滚）内会
       把「下拉 + 弹窗」一起滚动，视觉上下拉像被顶到屏幕中间、盖住大半个页面，
       用户反馈「下拉筛选股票会把页面全挡」。
       现在只保证**股票输入框**留在视野内即可 —— 下拉紧贴其下方，自然跟着可见。 */
    try { inp.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { /* */ }
  });
  const pick = e => {
    const it = e.target.closest('.sug-item');
    if (!it) return;
    e.preventDefault();
    onPick({ code: it.dataset.code, name: it.dataset.name, mkt: it.dataset.mkt });
    close();
  };
  box.addEventListener('pointerdown', pick);
  box.addEventListener('touchstart', pick, { passive: false });
  box.addEventListener('click', pick);
  inp.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  inp.addEventListener('blur', () => setTimeout(close, 120));
}

/* 确认模态（v3.8.43 起同一套骨架兼做「输入模态」，仅多一行输入框） */
export let confirmCb = null;
export let confirmInputCb = null;
export function confirmDlg(title, desc, onOk, okText) {
  $('confirmTitle').textContent = title;
  const d = $('confirmDesc'); d.textContent = desc; d.hidden = false;
  const inp = $('confirmInput'); inp.hidden = true; inp.value = '';
  const ok = $('confirmOk'); ok.textContent = okText || '确认'; ok.className = 'btn danger';
  confirmCb = onOk; confirmInputCb = null;
  $('confirmModal').hidden = false;
}
/* v3.8.43 输入模态：与 confirmDlg 完全同款，多一行输入框；onOk 收到去掉首尾空格的文本 */
export function promptDlg(title, desc, onOk, opt) {
  opt = opt || {};
  $('confirmTitle').textContent = title;
  const d = $('confirmDesc'); d.textContent = desc || ''; d.hidden = !desc;
  const inp = $('confirmInput');
  inp.hidden = false; inp.value = opt.value || ''; inp.placeholder = opt.placeholder || '';
  const ok = $('confirmOk'); ok.textContent = opt.okText || '确定'; ok.className = 'btn primary';
  confirmInputCb = onOk; confirmCb = null;
  $('confirmModal').hidden = false;
  setTimeout(() => { try { inp.focus(); inp.select(); } catch (e) { /* */ } }, 30);
}
export function closeConfirm() {
  $('confirmModal').hidden = true;
  const inp = $('confirmInput'); inp.hidden = true; inp.value = '';
  confirmCb = null; confirmInputCb = null;
}

/* ============================================================
   费用引擎（口径与 trade-manager 一致，‰，三市独立）
   ============================================================ */