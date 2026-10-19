/* 语音域：双引擎（Web Speech / MediaRecorder→ASR）（v0.11.0 自单体拆出） */
import { $, toast, fmt2, fmtP, fmtPct, pnlCls, esc, fmtTime, nowLocalInput, inferMarket, MKT_NAME } from '../shared/utils.js';
import { NetLog, sjTokenHeaders } from '../core/netlog.js';
import { StockDict } from '../core/stockdict.js';
import { DL } from '../core/data-layer.js';
import { emQuote, txQuote } from '../sources/quotes.js';
import { TABLES, BACKEND_URL, RPC_BASE, ACCESS_KEY, CLOUD_HOST, rpc, cloudStore, localStore, setStore, loadAll, saveSetting, sessionHooks, storageHooks } from '../storage/gateway.js';
import { S } from '../core/app-state.js';

export function sjCreateMic(cfg) {
  const btn = cfg.btn;
  if (!btn || btn.dataset.micBound) return;
  btn.dataset.micBound = '1';
  const getSR = () => window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null, mediaRec = null, mediaChunks = [], mediaStream = null;
  let holding = false, srBroken = false, mediaTimer = null;
  const hint = t => {
    let h = document.getElementById(cfg.hintId);
    if (!h) {
      h = document.createElement('div'); h.id = cfg.hintId; h.className = 'qa-rec-hint';
      const host = document.querySelector(cfg.hintHostSel || '.qa-composer');
      if (host) host.appendChild(h);
    }
    h.textContent = t; return h;
  };
  const stopUi = () => { btn.classList.remove('rec'); const h = document.getElementById(cfg.hintId); if (h) h.remove(); };
  const stopSr = () => { if (rec) { try { rec.stop(); } catch (e) { } rec = null; } };
  const stopMedia = () => {
    if (mediaTimer) { clearTimeout(mediaTimer); mediaTimer = null; }
    if (mediaRec) { try { if (mediaRec.state !== 'inactive') mediaRec.stop(); } catch (e) { } mediaRec = null; }
    if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  };
  const allStop = () => { stopSr(); stopMedia(); stopUi(); holding = false; };
  const setInp = txt => {
    const inp = cfg.input(); if (!inp) return;
    inp.value = txt.slice(0, 2000);
    if (cfg.onInput) cfg.onInput();
  };

  async function mediaStart() {
    if (!navigator.mediaDevices || !window.MediaRecorder) { allStop(); toast('此浏览器既不支持语音识别也不支持录音，请用 Edge / Chrome', 'warn'); return; }
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    /* v3.16.1 松手复查：getUserMedia 等待授权期间用户可能已松手 ——
       旧代码不复查 holding，回来后照样开录 → 录音永远停不下来。已松手立即弃流。 */
    if (!holding) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; return; }
    mediaChunks = [];
    const mime = MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
    mediaRec = new MediaRecorder(mediaStream, mime ? { mimeType: mime } : undefined);
    mediaRec.ondataavailable = e => { if (e.data && e.data.size) mediaChunks.push(e.data); };
    mediaRec.onstop = async () => {
      const blob = new Blob(mediaChunks, { type: (mediaRec && mediaRec.mimeType) || 'audio/webm' });
      stopMedia(); stopUi();
      if (blob.size < 2000) { toast('没录到声音，请重试', 'warn'); return; }
      try {
        const text = await sjAsrTranscribe(blob, hint);
        const inp = cfg.input();
        if (inp && text) {
          setInp(inp.value ? inp.value + ' ' + text : text);
          if (cfg.onDone) cfg.onDone(text);
        } else if (!text) toast('未识别到内容，请重试', 'warn');
      } catch (e) { toast('服务器转写失败：' + (e.message || e), 'warn'); }
    };
    mediaRec.start();
    /* v3.16.1 保险丝：单次录音最长 60s（腾讯云一句话识别同为 60s 上限），绝不挂死 */
    mediaTimer = setTimeout(() => {
      if (mediaRec && mediaRec.state !== 'inactive') { try { mediaRec.stop(); } catch (e) { } }
    }, 60000);
    btn.classList.add('rec');
    hint('🎙 录音中（服务器转写）… 松开结束');
  }

  btn.addEventListener('contextmenu', e => e.preventDefault());
  btn.addEventListener('pointerdown', e => {
    e.preventDefault();
    /* v3.16.1 指针捕获：按住后移出按钮/窗口再松开，pointerup 也能派发到本按钮 */
    try { btn.setPointerCapture(e.pointerId); } catch (e0) { }
    if (rec || mediaRec || holding) return;
    holding = true;
    const SR = getSR();
    if (SR && !srBroken) {
      const inp = cfg.input();
      const base = inp ? inp.value : '';
      try { rec = new SR(); } catch (e2) { rec = null; srBroken = true; mediaStart().catch(err => { allStop(); toast('录音启动失败：' + err.message, 'warn'); }); return; }
      rec.lang = 'zh-CN';
      rec.interimResults = true;
      rec.continuous = true;   /* v3.16.1：false 时停顿几秒 SR 会自动 end，按住却没在听 */
      rec.onresult = ev => {
        let txt = '';
        for (let i = ev.resultIndex; i < ev.results.length; i++) txt += ev.results[i][0].transcript;
        setInp(base + txt);
      };
      rec.onerror = ev => {
        const err = ev && ev.error || '';
        /* 权限拒绝任何引擎都一样，直接终止；服务性错误且仍按住 → 无缝切引擎B */
        if (err === 'not-allowed' || err === 'audio-capture') { allStop(); toast('麦克风权限被拒绝', 'warn'); return; }
        if (holding) {
          stopSr(); srBroken = true;
          hint('⏳ 切换服务器转写…');
          mediaStart().catch(err2 => { allStop(); toast('录音启动失败：' + err2.message, 'warn'); });
        } else {
          allStop();
          toast('语音识别失败：' + err, 'warn');
        }
      };
      rec.onend = () => {
        rec = null;
        /* v3.16.1：按住期间 SR 自己断了（网络抖动/超时）→ 无缝切引擎B，松手才停 */
        if (holding && !srBroken && !mediaRec) {
          hint('⏳ 切换服务器转写…');
          mediaStart().catch(err2 => { allStop(); toast('录音启动失败：' + err2.message, 'warn'); });
        } else if (!holding && !mediaRec) stopUi();
      };
      try {
        rec.start();
        btn.classList.add('rec');
        hint('🎙 正在听…松开结束');
      } catch (e3) { rec = null; srBroken = true; mediaStart().catch(err2 => { allStop(); toast('录音启动失败：' + err2.message, 'warn'); }); }
    } else {
      mediaStart().catch(err => { allStop(); toast('录音启动失败：' + err.message, 'warn'); });
    }
  });
  const endHandler = e => {
    e.preventDefault();
    /* v3.16.1：不以 holding 为前置条件 —— 先把所有还活着的引擎停干净，防竞态漏停 */
    if (rec) { try { rec.stop(); } catch (e2) { } rec = null; }
    if (mediaRec && mediaRec.state !== 'inactive') {
      try { mediaRec.stop(); } catch (e3) { }   // onstop 里转写+清UI
      holding = false;
      return;
    }
    /* getUserMedia 还挂着：先清 UI，mediaStart 内部复查 !holding 后自行放弃 */
    if (mediaStream) stopMedia();
    stopUi();
    holding = false;
  };
  btn.addEventListener('pointerup', endHandler);
  btn.addEventListener('pointercancel', endHandler);
  btn.addEventListener('pointerleave', () => { if (holding) endHandler({ preventDefault() { } }); });
}

/* ============================================================
   v3.17.0 引擎B 转写：后端可选（本机 localStorage sj_asr_v1，不上云）
   - 腾讯云一句话识别：不收 webm、不允许浏览器直连（无 CORS）→ 只能经
     自托管 /api/asr/tencent（服务端 TC3 签名）；录音先统一转 16k 单声道 WAV
   - 硅基流动：CORS 开放 → 自托管 /api/asr 代理 或 云端版浏览器直连
   - backend auto = 硅基服务端 → 硅基直连 → 腾讯云代理 依次降级
   ============================================================ */
export function sjAsrCfgGet() {
  let c = {};
  try { c = JSON.parse(localStorage.getItem('sj_asr_v1') || '{}') || {}; } catch (e) { }
  return { backend: c.backend || 'auto', sfKey: c.sfKey || '', txId: c.txId || '', txKey: c.txKey || '' };
}
export function sjAsrCfgSet(patch) {
  const c = Object.assign(sjAsrCfgGet(), patch);
  localStorage.setItem('sj_asr_v1', JSON.stringify(c));
  return c;
}

/* 任意浏览器可解码音频 → 16k 单声道 WAV（零依赖：AudioContext 解码 +
   OfflineAudioContext 重采样 + 手写 WAV 头）。腾讯云只收 wav 等格式，不收 webm */
export async function sjBlobToWav16k(blob) {
  const ab = await blob.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  const tmp = new AC();
  let buf;
  try { buf = await tmp.decodeAudioData(ab); } finally { try { tmp.close(); } catch (e) { } }
  const rate = 16000;
  const off = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, Math.max(1, Math.ceil(buf.duration * rate)), rate);
  const src = off.createBufferSource(); src.buffer = buf; src.connect(off.destination); src.start();
  const rendered = await off.startRendering();
  const pcm = rendered.getChannelData(0);
  const n = pcm.length;
  const out = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(out);
  const wr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  wr(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); wr(8, 'WAVE'); wr(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  wr(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, pcm[i]));
    dv.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7FFF, true);
  }
  return new Blob([out], { type: 'audio/wav' });
}

export async function sjBlobB64(blob) {
  const u8 = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

/* 引擎B 主入口：按设置选后端、逐级降级；hint(t) 更新「⏳ 转写中」提示 */
export async function sjAsrTranscribe(rawBlob, hint) {
  const cfg = sjAsrCfgGet();
  const wav = await sjBlobToWav16k(rawBlob);
  const auth = typeof sjTokenHeaders === 'function' ? sjTokenHeaders() : {};
  const tryTx = async () => {
    if (hint) hint('⏳ 转写中（腾讯云）…');
    const r = await fetch('/api/asr/tencent', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, auth),
      body: JSON.stringify({ audio: await sjBlobB64(wav), len: wav.size, keys: (cfg.txId && cfg.txKey) ? { id: cfg.txId, key: cfg.txKey } : null }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.msg || ('HTTP ' + r.status));
    return j.text || '';
  };
  const trySfProxy = async () => {
    if (hint) hint('⏳ 转写中（硅基流动·服务端）…');
    const fd = new FormData();
    fd.append('audio', wav, 'speech.wav');
    const r = await fetch('/api/asr', { method: 'POST', headers: auth, body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.msg || ('HTTP ' + r.status));
    return j.text || '';
  };
  const trySfDirect = async () => {
    if (!cfg.sfKey) throw new Error('未配置硅基流动 Key：设置→语音转写 里粘贴 sfr- 开头的 Key（存本机）');
    if (hint) hint('⏳ 转写中（硅基流动·直连）…');
    const fd = new FormData();
    fd.append('file', wav, 'speech.wav');
    fd.append('model', 'FunAudioLLM/SenseVoiceSmall');
    const r = await fetch('https://api.siliconflow.cn/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: 'Bearer ' + cfg.sfKey }, body: fd,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || j.error ? String(j.message || j.error || ('HTTP ' + r.status)) : 'HTTP ' + r.status);
    return j.text || '';
  };
  const chain = cfg.backend === 'tx' ? [tryTx, trySfProxy, trySfDirect]
    : cfg.backend === 'sf' ? [trySfProxy, trySfDirect]
      : [trySfProxy, trySfDirect, tryTx];
  let lastErr = null;
  for (const fn of chain) {
    try { const t = await fn(); if (t) return t; lastErr = new Error('未识别到内容'); }
    catch (e) {
      lastErr = e;
      const msg = String(e.message || e);
      /* 只有「未配置/路由不存在」才降级到下一个后端；额度耗尽等业务错误直接抛给用户 */
      if (!/未配置|HTTP 40[14]|没有收到/.test(msg) && msg.indexOf('HTTP ') !== 0) throw e;
    }
  }
  throw lastErr || new Error('转写失败');
}
/* 问答历史首载：登录后拉一次（放在 boot 之后，失败不影响其它模块） */