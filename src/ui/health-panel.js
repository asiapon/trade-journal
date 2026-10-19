/* 数据源健康面板（v0.12.0 M4）：渲染 DataLayer 健康统计到 设置→数据管理。
   每源一枚胶囊：成功率 / 调用次数 / 平均耗时 / 熔断状态——观测从被动翻日志变主动可见。 */

import { DL } from '../core/data-layer.js';
import { esc } from '../shared/utils.js';

export function renderHealthPanel(mountId) {
  const el = document.getElementById(mountId || 'dlHealth');
  if (!el) return;
  const rows = DL.health().filter(r => r.ok + r.fail > 0);
  if (!rows.length) {
    el.innerHTML = '<span class="hint">数据源健康：本次会话暂无取数记录（打开总览/自选或刷新行情后出现）</span>';
    return;
  }
  el.innerHTML = '<span class="hint" style="width:100%">数据源健康（本次会话）：</span>' + rows.map(r => {
    const cls = r.breakerOpen ? 'cap-no' : (r.rate === null ? '' : (r.rate >= 90 ? 'cap-ok' : (r.rate >= 60 ? '' : 'cap-no')));
    const t = r.breakerOpen
      ? '熔断中 · 剩余 ' + Math.ceil(r.cooldownLeft / 60000) + ' 分'
      : (r.rate === null ? '无调用' : r.rate + '% · ' + (r.ok + r.fail) + ' 次' + (r.avgMs != null ? ' · 均 ' + r.avgMs + 'ms' : ''));
    const tip = r.lastErr ? esc(r.lastErr).slice(0, 160) : '';
    return '<span class="cap-pill ' + cls + '" title="' + esc(r.src) + (tip ? ' · 最近错误：' + tip : '') + '">'
      + esc(r.src) + ' ' + t + '</span>';
  }).join('') + (rows.some(r => r.lastErr) ? '' : '');
}
