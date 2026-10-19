/* 操作日志 · 应用入口
   v0：legacy 整体移植（三页 → 五页全功能）
   v0.4：环境能力自动探测 + 设置页能力面板 */
import './app.js';
import { detectCapabilities, renderCapBar } from './core/capabilities.js';
import { NetLog } from './core/netlog.js';

/* v0.12.5 全局错误进日志：UI 层异常（如点击处理器里的 ReferenceError）原先只 toast、
   不进 NetLog → 自托管文件日志里查不到。这里兜底捕获后走 NetLog（设置页可见 +
   自托管经 outbox 落 deploy/logs 文件）。 */
window.addEventListener('error', e => {
  try { NetLog.push('ui', 'window.onerror', false, 0, (e.message || '未知错误') + ' @' + String(e.filename || '').split('/').pop() + ':' + e.lineno); } catch (_e) { /* */ }
});
window.addEventListener('unhandledrejection', e => {
  try { const r = e.reason; NetLog.push('ui', 'unhandledRejection', false, 0, String(r && r.message || r).slice(0, 200)); } catch (_e) { /* */ }
});

/* boot 后探测后端能力（避开初始化峰值），结果供设置页面板与各卡片按能力渲染 */
setTimeout(async () => {
  try {
    const caps = await detectCapabilities();
    window.__CAPS = caps;
    renderCapBar(caps, 'capBar');
    window.renderCapBar = () => renderCapBar(window.__CAPS, 'capBar');
    try { if (typeof renderNetLogUI === 'function') renderNetLogUI(); } catch (e) { /* */ }
  } catch (e) { /* 探测失败不影响使用 */ }
}, 2500);
