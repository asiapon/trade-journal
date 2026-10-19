/* ============================================================
   操作日记 · Cloudflare Worker 后端（v3.19.0）
   ------------------------------------------------------------
   静态资源（assets）+ 同源 API，替代 deploy/server.js 的云端角色：
     · POST /.cloud/database/rest/rpc/<fn>   18 个 RPC（见 src/rpc.js，D1 实现）
     · GET  /healthz
     · POST /api/log            前端调用日志批量上报 → D1 net_log
     · GET  /api/logs/tail|download     日志查看/下载（会话鉴权）
     · GET  /api/klib/daily     K线按交易日覆盖统计（json_each 展开 bars[0]）
     · POST /api/asr            硅基流动转写代理（secret ASR_API_KEY）
     · POST /api/asr/tencent    腾讯云一句话识别 TC3 签名（secrets TENCENT_*，
                                WebCrypto 版 HMAC，无 Node crypto 依赖）
     · GET  /api/sync/status    无服务端定时采集（ Workers cron 后续可加），如实返回
   鉴权：RPC 走 p_token（app_sessions，30 天）；/api/* 走 x-sj-token 头。
   不支持：Python 技能包（/api/pack/* 缺席 → 前端技能中心相应项不可用，其余无影响）。
   ============================================================ */
'use strict';
import { handleRpc, sessionUser, nowIso, ok, bad } from './rpc.js';

/* ---------- 响应助手 ---------- */
const jres = (data, status) => new Response(JSON.stringify(data), {
  status: status || 200,
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
});

/* ---------- TC3 签名（WebCrypto 版，对齐 server.js 的 crypto 实现） ---------- */
const enc = new TextEncoder();
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}
async function sha256hex(msg) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(msg));
  return Array.from(new Uint8Array(d), x => x.toString(16).padStart(2, '0')).join('');
}

/* ---------- 日志写入（net_log） ---------- */
async function logToD1(db, kind, name, okFlag, ms, detail, src) {
  const ts = nowIso();
  try {
    await db.prepare('INSERT INTO net_log (ts, day, kind, name, ok, ms, detail, src) VALUES (?,?,?,?,?,?,?,?)')
      .bind(ts, ts.slice(0, 10), String(kind || 'fetch').slice(0, 40), String(name || '').slice(0, 120),
        okFlag ? 1 : 0, Math.round(Number(ms) || 0), String(detail || '').slice(0, 500), String(src || '').slice(0, 200)).run();
  } catch (e) { /* 日志写失败不影响主流程 */ }
}
const fmtLine = r => `${r.ts} | web | ${r.kind} | ${r.name} | ${r.ok ? 'OK' : 'FAIL'} | ${r.ms}ms | ${r.detail || ''} | ${r.src || ''}`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const db = env.DB;

    try {
      /* ---------- 健康检查 ---------- */
      if (path === '/healthz') {
        let d1 = 'down';
        try { await db.prepare('SELECT 1 AS x').first(); d1 = 'up'; } catch (e) { /* */ }
        return jres({ ok: true, ts: Date.now(), d1 });
      }

      /* ---------- 环境能力自报（设置页「环境能力」面板数据源） ---------- */
      if (path === '/api/capabilities') {
        return jres({
          ok: true, env: 'cloudflare',
          serverLogs: true,                                  // 调用日志落 D1（net_log 表）
          packExec: false,                                   // Workers 不跑 Python
          asr: !!env.ASR_API_KEY,                            // 硅基代理可用性随 secret
          asrTencent: !!(env.TENCENT_SECRET_ID && env.TENCENT_SECRET_KEY),
          syncCron: false,                                   // cron trigger 可后续加
        });
      }

      /* ---------- RPC 兼容层（与 WorkBuddy 云端 / 自托管同协议） ---------- */
      if (path.startsWith('/.cloud/database/rest/rpc/')) {
        const fn = path.slice('/.cloud/database/rest/rpc/'.length).replace(/\/+$/, '');
        let body = {};
        try { body = await request.json(); } catch (e) { /* 空 body 允许（app_has_users 无参） */ }
        const t0 = Date.now();
        const r = await handleRpc(db, fn, body);
        const b = r.body;
        logToD1(db, 'rpc', fn, r.status === 200 && (b === true || b.ok !== false), Date.now() - t0,
          r.status === 200 ? (b && b.data ? (Array.isArray(b.data) ? b.data.length + ' 行' : 'ok') : 'ok') : (b && b.msg || 'err'),
          (body && (body.p_table || body.table)) || '');
        return jres(b, r.status);
      }

      /* ---------- 会话鉴权（/api/* 与自托管一致：x-sj-token 头） ---------- */
      const sessionOk = await sessionUser(db, request.headers.get('x-sj-token') || '');

      /* ---------- 调用日志 ---------- */
      if (path === '/api/log' && request.method === 'POST') {
        if (!sessionOk) return jres(bad('需要登录（token 无效）'), 401);
        let body = {};
        try { body = await request.json(); } catch (e) { /* */ }
        const entries = Array.isArray(body.entries) ? body.entries.slice(0, 100) : [];
        for (const e of entries) {
          await logToD1(db, e.kind || 'fetch', e.name || '', e.ok !== false, e.ms || 0, e.detail || '', e.src || '');
        }
        return jres({ ok: true, accepted: entries.length });
      }
      if (path === '/api/logs/tail') {
        if (!sessionOk) return jres(bad('需要登录（token 无效）'), 401);
        const n = Math.min(2000, Math.max(1, parseInt(url.searchParams.get('n'), 10) || 200));
        const { results } = await db.prepare('SELECT * FROM net_log ORDER BY id DESC LIMIT ?').bind(n).all();
        return jres({ ok: true, file: 'd1://net_log', lines: (results || []).map(fmtLine).reverse() });
      }
      if (path === '/api/logs/download') {
        if (!sessionOk) return jres(bad('需要登录（token 无效）'), 401);
        const { results } = await db.prepare('SELECT * FROM net_log ORDER BY id DESC LIMIT 5000').all();
        const txt = (results || []).map(fmtLine).reverse().join('\n') || '(空)';
        return new Response(txt, {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': 'attachment; filename="app-' + nowIso().slice(0, 10) + '.log"',
          },
        });
      }

      /* ---------- K 线按交易日覆盖统计（对账视图，缓存 10 分钟） ---------- */
      if (path === '/api/klib/daily') {
        if (!sessionOk) return jres(bad('需要登录（token 无效）'), 401);
        if (globalThis.__klibDaily && Date.now() - globalThis.__klibDaily.at < 600000) {
          return jres(Object.assign({ ok: true, cached: true }, globalThis.__klibDaily.data));
        }
        try {
          const { results } = await db.prepare(
            `SELECT json_extract(b.value, '$[0]') AS day, COUNT(*) AS stocks
               FROM kline_cache, json_each(kline_cache.bars) b
              GROUP BY day ORDER BY day DESC LIMIT 120`).all();
          const tot = await db.prepare('SELECT COUNT(*) AS n FROM kline_cache').first();
          const data = { total: tot.n, rows: results || [] };
          globalThis.__klibDaily = { at: Date.now(), data };
          return jres(Object.assign({ ok: true, cached: false }, data));
        } catch (e) { return jres(bad('统计失败: ' + (e.message || e)), 500); }
      }

      /* ---------- 语音转写：硅基流动（secret ASR_API_KEY） ---------- */
      if (path === '/api/asr' && request.method === 'POST') {
        if (!sessionOk) return jres(bad('需要登录（token 无效）'), 401);
        const key = env.ASR_API_KEY || '';
        if (!key) return jres(bad('服务器未配置 ASR_API_KEY：可在 设置→语音转写 选择「浏览器直连硅基」模式，或用 wrangler secret put ASR_API_KEY 配置'), 501);
        const ab = await request.arrayBuffer();
        if (!ab || !ab.byteLength) return jres(bad('没有收到录音'), 400);
        if (ab.byteLength > 14 * 1024 * 1024) return jres(bad('录音超过 14MB'), 400);
        const t0 = Date.now();
        try {
          const fd = new FormData();
          fd.append('file', new Blob([ab], { type: request.headers.get('content-type') || 'audio/webm' }), 'speech.webm');
          fd.append('model', env.ASR_MODEL || 'FunAudioLLM/SenseVoiceSmall');
          const r = await fetch('https://api.siliconflow.cn/v1/audio/transcriptions', {
            method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: fd, signal: AbortSignal.timeout(30000),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) {
            logToD1(db, 'asr', 'transcribe', false, Date.now() - t0, 'HTTP ' + r.status + ': ' + (j.message || j.error || ''), '');
            return jres(bad('ASR 服务返回 ' + r.status + (j.message ? '：' + j.message : '')), 502);
          }
          logToD1(db, 'asr', 'transcribe', true, Date.now() - t0, (j.text || '').slice(0, 80), '');
          return jres({ ok: true, text: j.text || '' });
        } catch (e) {
          logToD1(db, 'asr', 'transcribe', false, Date.now() - t0, e.message || String(e), '');
          return jres(bad('转写失败：' + (e.message || e)), 502);
        }
      }

      /* ---------- 语音转写：腾讯云一句话识别（TC3，WebCrypto） ---------- */
      if (path === '/api/asr/tencent' && request.method === 'POST') {
        if (!sessionOk) return jres(bad('需要登录（token 无效）'), 401);
        let body = {};
        try { body = await request.json(); } catch (e) { /* */ }
        const sid = env.TENCENT_SECRET_ID || (body.keys && body.keys.id) || '';
        const skey = env.TENCENT_SECRET_KEY || (body.keys && body.keys.key) || '';
        if (!sid || !skey) return jres(bad('未配置腾讯云密钥：在 设置→语音转写 里填一对保存后重试（或 wrangler secret put TENCENT_SECRET_ID/KEY）'), 501);
        const b64 = body.audio || '', len = Number(body.len) || 0;
        if (!b64 || !len) return jres(bad('没有收到录音'), 400);
        if (len > 3 * 1024 * 1024) return jres(bad('录音超过 3MB（60 秒上限），请说短一点'), 400);
        const host = 'asr.tencentcloudapi.com', service = 'asr';
        const region = env.TENCENT_ASR_REGION || 'ap-shanghai';
        const engine = env.TENCENT_ASR_ENGINE || '16k_zh';
        const payload = JSON.stringify({
          ProjectId: 0, SubServiceType: 2, EngSerViceType: engine,
          SourceType: 1, VoiceFormat: 'wav', Data: b64, DataLen: len,
        });
        const ts = Math.floor(Date.now() / 1000);
        const date = new Date(ts * 1000).toISOString().slice(0, 10);
        const canonical = 'POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:' + host
          + '\n\ncontent-type;host\n' + await sha256hex(payload);
        const stringToSign = 'TC3-HMAC-SHA256\n' + ts + '\n' + date + '/' + service + '/tc3_request\n' + await sha256hex(canonical);
        const kDate = await hmac('TC3' + skey, date);
        const kService = await hmac(kDate, service);
        const kSigning = await hmac(kService, 'tc3_request');
        const sigBytes = await crypto.subtle.importKey('raw', kSigning, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
          .then(k => crypto.subtle.sign('HMAC', k, enc.encode(stringToSign)));
        const signature = Array.from(new Uint8Array(sigBytes), x => x.toString(16).padStart(2, '0')).join('');
        const auth = 'TC3-HMAC-SHA256 Credential=' + sid + '/' + date + '/' + service + '/tc3_request, '
          + 'SignedHeaders=content-type;host, Signature=' + signature;
        const t0 = Date.now();
        try {
          const r = await fetch('https://' + host + '/', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              'X-TC-Action': 'SentenceRecognition', 'X-TC-Version': '2019-06-14',
              'X-TC-Region': region, 'X-TC-Timestamp': String(ts), Authorization: auth,
            },
            body: payload, signal: AbortSignal.timeout(30000),
          });
          const j = await r.json().catch(() => ({}));
          const resp = j.Response || {};
          if (resp.Error) {
            logToD1(db, 'asr', 'tencent', engine, false, Date.now() - t0, resp.Error.Code + ': ' + resp.Error.Message, '');
            const noQuota = /UserHasNo|ServiceIsolate|FailedOperation/.test(resp.Error.Code || '');
            return jres(bad('腾讯云：' + resp.Error.Code + ' ' + resp.Error.Message
              + (noQuota ? '（免费额度耗尽或服务未开通？控制台确认下；新用户默认关闭后付费，不会乱扣钱）' : '')), 502);
          }
          logToD1(db, 'asr', 'tencent', engine, true, Date.now() - t0, (resp.Result || '').slice(0, 80), '');
          return jres({ ok: true, text: resp.Result || '' });
        } catch (e) {
          logToD1(db, 'asr', 'tencent', engine, false, Date.now() - t0, e.message || String(e), '');
          return jres(bad('腾讯云转写失败：' + (e.message || e)), 502);
        }
      }

      /* ---------- 服务端定时采集：Workers 版暂无（后续可加 cron trigger） ---------- */
      if (path === '/api/sync/status') {
        return jres({ ok: true, syncAt: 0, running: false, last: null, note: 'Cloudflare 版暂无服务端定时采集；K线增量在打开应用时自动进行' });
      }
      if (path === '/api/sync/run') {
        if (!sessionOk) return jres(bad('需要登录（token 无效）'), 401);
        return jres({ ok: false, msg: 'Cloudflare 版暂无服务端定时采集；K线增量在打开应用时自动进行' });
      }

      /* ---------- 其余：交给静态资源（未命中 → index.html，与自托管 catch-all 一致） ---------- */
      return env.ASSETS.fetch(request);
    } catch (e) {
      return jres(bad('服务器错误: ' + (e && e.message || e)), 500);
    }
  },
};
