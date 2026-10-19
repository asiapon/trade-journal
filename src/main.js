/* 操作日志 · 应用入口
   v0：legacy 整体移植（三页 → 五页全功能）
   v0.4：环境能力自动探测 + 设置页能力面板 */
import './app.js';
import { detectCapabilities, renderCapBar } from './core/capabilities.js';

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
