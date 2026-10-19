/* 网络日志（自 legacy 拆出）：内存环 + localStorage + outbox 批量上报 */
export function sjTokenHeaders(extra) {
  const h = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
  const t = localStorage.getItem('sj_token'); if (t) h['x-sj-token'] = t;
  return h;
}
export const NetLog = {
  buf: [],
  max: 800,
  _saveT: null,
  _ctx: [],                                    // 触发来源栈（后进先出）
  load() { try { this.buf = JSON.parse(localStorage.getItem('sj_netlog') || '[]'); } catch (e) { this.buf = []; } },
  /* withCtx('功能·操作', fn)：fn 同步或返回 Promise 均可，结束后恢复原栈。
     并发交错时以最内层为准（恢复按快照，尽力而为）——本项目数据调用基本是用户顺序触发，够用。 */
  withCtx(label, fn) {
    const prev = this._ctx.slice();
    this._ctx.push(label);
    try {
      const r = fn();
      if (r && typeof r.then === 'function') return r.finally(() => { this._ctx = prev; });
      this._ctx = prev;
      return r;
    } catch (e) { this._ctx = prev; throw e; }
  },
  curCtx() { return this._ctx[this._ctx.length - 1] || ''; },
  _cut(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; },
  push(kind, name, ok, ms, detail, extra) {
    const x = extra || {};
    const e = {
      t: new Date().toISOString(), kind, name, ok: !!ok, ms: Math.round(ms),
      detail: this._cut(detail, 400),
      src: this._cut(x.src != null ? x.src : this.curCtx(), 120),
      url: this._cut(x.url, 400),
      req: this._cut(x.req, 300),
      resp: this._cut(x.resp, 300),
      err: this._cut(x.err != null ? x.err : (ok ? '' : detail), 300),
    };
    this.buf.unshift(e);
    if (this.buf.length > this.max) this.buf.length = this.max;
    this._outbox.push(e);
    clearTimeout(this._saveT);
    this._saveT = setTimeout(() => {
      try { localStorage.setItem('sj_netlog', JSON.stringify(this.buf.slice(0, 200))); } catch (err) { /* 存储满则只在内存 */ }
    }, 1500);
    if (!ok) console.warn('[net-fail]', kind, name, detail, Math.round(ms) + 'ms');
    this._scheduleUpload();
  },
  /* v3.12.4 上报：把每次调用批量发到自托管后端，落 logs/app-YYYYMMDD.log。
     云端托管版没有该端点（404）→ 本次会话静默停用；file:// 同理跳过。 */
  _outbox: [],
  _upDisabled: false,
  _upT: null,
  _scheduleUpload() {
    clearTimeout(this._upT);
    this._upT = setTimeout(() => this.flushToServer(), 2500);
  },
  flushToServer() {
    if (this._upDisabled || location.protocol === 'file:') return;
    if (!this._outbox.length) return;
    const entries = this._outbox.splice(0, this._outbox.length);
    fetch('/api/log', { method: 'POST', headers: sjTokenHeaders(),
      body: JSON.stringify({ entries: entries.map(x => ({ t: x.t, kind: x.kind, name: x.name, ok: x.ok, ms: x.ms, detail: x.detail, src: x.src })) }) })
      .then(r => { if (!r.ok) this._upDisabled = true; })
      .catch(() => { this._upDisabled = true; });
  },
  /* 下载文本：一条一块、带标签行，缺的字段不输出（不像旧版挤在一行什么都要猜） */
  text() {
    return this.buf.map((e, i) => {
      const lines = [
        `#${this.buf.length - i} ${e.t} [${e.ok ? 'OK' : 'FAIL 未获取到'}] ${e.kind} ${e.name} ${e.ms}ms`,
      ];
      if (e.src) lines.push('  触发：' + e.src);
      if (e.url) lines.push('  请求：' + e.url);
      if (e.req && e.req !== e.url) lines.push('  参数：' + e.req);
      lines.push(e.ok ? ('  返回：' + (e.resp || e.detail || '(空)')) : ('  错误：' + (e.err || e.detail || '未知')));
      if (e.ok && e.resp && e.detail && e.resp !== e.detail) lines.push('  摘要：' + e.detail);
      return lines.join('\n');
    }).join('\n');
  },
  clear() { this.buf = []; try { localStorage.removeItem('sj_netlog'); } catch (e) { /* */ } }
};
NetLog.load();
