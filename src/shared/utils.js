/* 共享工具层（自 legacy 拆出）——纯函数与 DOM 微件，无业务依赖 */
export const $ = id => document.getElementById(id);

/* ============================================================
   工具
   ============================================================ */
export function toast(msg, type) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'show' + (type ? ' ' + type : '');
  clearTimeout(t._tm);
  t._tm = setTimeout(() => { t.className = ''; }, 2200);
}
export function fmt2(n) { return n == null || isNaN(n) ? '—' : Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
/* v3.8.61 价格类数值固定 3 位小数（原为 maximumFractionDigits:3，会抹掉末尾零，
   使 44.810 显示成 44.81，同一列数字长短不齐）。改为 min=max=3 与 fmt2 同构。
   影响：持仓表成本价、展开区「成本」胶囊、自选锚点价、交易价格文案 —— 均为价格语义，口径统一。 */
export function fmtP(n) { return n == null || isNaN(n) ? '—' : Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 3, maximumFractionDigits: 3 }); }
export function fmtPct(n) { return (n > 0 ? '+' : '') + (n * 100).toFixed(2) + '%'; }
export function pnlCls(n) { return n > 0 ? 'pos' : n < 0 ? 'neg' : 'neu'; }
export function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
export function fmtTime(ts, withYear) {
  const d = new Date(ts);
  if (isNaN(d)) return '—';
  const p = n => String(n).padStart(2, '0');
  const base = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return withYear ? `${d.getFullYear()}-${base}` : base;
}
export function nowLocalInput() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function inferMarket(code) {
  if (/^6/.test(code)) return 'sh';
  if (/^(0|3)/.test(code)) return 'sz';
  if (/^(4|8|9)/.test(code)) return 'bj';
  return 'sz';
}
export const MKT_NAME = { sh: '沪市', sz: '深市', bj: '北交所', bse: '北交所' };
