(() => {
'use strict';
const $ = s => document.querySelector(s);

/* ---------- calibration constants ----------
   AnalyserNode applies a Blackman window and scales the FFT by 1/N.
   A full-scale sine then reads 20·log10(0.5·0.42) = −13.56 dB in a single bin,
   so LINE_CAL makes a 0 dBFS sine read 0 dB.
   For band (power-sum) display the window's power gain mean(w²)=0.3046 is used,
   so a sine inside a band also reads its true dBFS. */
const LINE_CAL = -20 * Math.log10(0.5 * 0.42);
const BAND_CAL = 10 * Math.log10(4 / 0.3046);
const FMIN = 20;
const NOTES = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
const STORE = 'spektre-v2';

const DEF = { fft:16384, smooth:0.5, mode:'line', slope:4.5, peak:'decay', floor:-100, chan:'mix', sg:false };
const S = Object.assign({}, DEF);
try { Object.assign(S, JSON.parse(localStorage.getItem(STORE) || '{}')); } catch (e) {}
const save = () => { try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) {} };

/* ---------- elements ---------- */
const specCv = $('#spec'), sgCv = $('#sgram'), stage = $('#stage');
const sx = specCv.getContext('2d'), gx = sgCv.getContext('2d');
const statusEl = $('#status');
const btn = { mic:$('#bMic'), share:$('#bShare'), file:$('#bFile') };

/* ---------- audio state ---------- */
let ctx = null, analyser = null, src = null, splitter = null, stream = null;
let mediaEl = null, mediaUrl = null, testNodes = [], toDest = false, kind = null;
let fbuf, tbuf, dbw, nb = 0, binHz = 1, sr = 48000, fmax = 20000;
let frozen = false, wakeLock = null;

/* ---------- display state ---------- */
let L = {}, gridCv = null, bands = [];
let disp = new Float32Array(0), hold = new Float32Array(0), low = new Uint8Array(0);
let cursor = null, lastT = 0, lastRO = 0, peakInfo = null, dirty = true;

/* ---------- helpers ---------- */
const log10 = Math.log10;
function setStatus(t, err) { statusEl.textContent = t || ''; statusEl.classList.toggle('err', !!err); }
function fmtF(f) { return f < 1000 ? f.toFixed(f < 100 ? 2 : 1) + ' Hz' : (f / 1000).toFixed(f < 10000 ? 3 : 2) + ' kHz'; }
function fmtDb(d) { return (d <= -200 || !isFinite(d)) ? '−∞ dB' : (d < 0 ? '−' : '+') + Math.abs(d).toFixed(1) + ' dB'; }
function noteOf(f) {
  const n = 12 * Math.log2(f / 440) + 69, r = Math.round(n), c = Math.round((n - r) * 100);
  if (r < 0 || r > 135) return '—';
  return NOTES[r % 12] + (Math.floor(r / 12) - 1) + ' ' + (c >= 0 ? '+' : '−') + Math.abs(c) + '¢';
}
// display tilt in dB/oct, pivoting at 1 kHz (readouts stay unsloped dBFS)
function slopeAt(f) { return S.slope ? S.slope * Math.log2(f / 1000) : 0; }

/* ---------- analyser setup ---------- */
function configureAnalyser() {
  if (!analyser) return;
  analyser.fftSize = S.fft;
  analyser.smoothingTimeConstant = S.smooth;
  nb = analyser.frequencyBinCount;
  sr = ctx.sampleRate;
  binHz = sr / S.fft;
  fmax = Math.min(20000, sr / 2);
  fbuf = new Float32Array(nb);
  dbw = new Float32Array(nb).fill(-200);
  tbuf = new Float32Array(S.fft);
  buildBands();
  resetHold();
  layout();
}
function buildBands() {
  bands = [];
  if (S.mode === 'line') return;
  const n = +S.mode, h = Math.pow(2, 1 / (2 * n));
  for (let k = -200; k < 200; k++) {
    const fc = 1000 * Math.pow(2, k / n);
    if (fc < FMIN || fc > fmax) continue;
    bands.push({ fc, lo: fc / h, hi: Math.min(fc * h, sr / 2) });
  }
}
function resetHold() { hold.fill(-999); }

async function ensureCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('This browser has no Web Audio support.');
    ctx = new AC({ latencyHint: 'interactive' });
    analyser = ctx.createAnalyser();
    analyser.minDecibels = -160; analyser.maxDecibels = 0;
    configureAnalyser();
  }
  if (ctx.state !== 'running') await ctx.resume();
}

function route() {
  if (!src) return;
  try { src.disconnect(); } catch (e) {}
  if (splitter) { try { splitter.disconnect(); } catch (e) {} }
  if (S.chan === 'mix') src.connect(analyser);
  else {
    if (!splitter) splitter = ctx.createChannelSplitter(2);
    src.connect(splitter);
    splitter.connect(analyser, S.chan === 'L' ? 0 : 1);
  }
  if (toDest) src.connect(ctx.destination);
}

function stopSource(keepStatus) {
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  if (src) { try { src.disconnect(); } catch (e) {} src = null; }
  testNodes.forEach(n => { try { n.stop && n.stop(); n.disconnect(); } catch (e) {} }); testNodes = [];
  if (mediaEl) { mediaEl.pause(); mediaEl.remove(); mediaEl = null; }
  if (mediaUrl) { URL.revokeObjectURL(mediaUrl); mediaUrl = null; }
  $('#filebar').hidden = true;
  toDest = false; kind = null;
  Object.values(btn).forEach(b => b.setAttribute('aria-pressed', 'false'));
  if (dbw) dbw.fill(-200);
  resetHold(); peakInfo = null; dirty = true;
  releaseWake();
  if (!keepStatus) setStatus('Stopped.');
}

function began(k, label) {
  kind = k;
  btn[k].setAttribute('aria-pressed', 'true');
  route();
  resetHold();
  requestWake();
  setStatus(label + ' · ' + sr + ' Hz');
}

/* ---------- sources ---------- */
async function startMic(deviceId) {
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error(window.isSecureContext ? 'Microphone access is not available in this browser.' : 'Microphone access needs HTTPS (or localhost).');
    await ensureCtx();
    stopSource(true);
    const audio = { echoCancellation:false, noiseSuppression:false, autoGainControl:false, channelCount:{ ideal:2 } };
    if (deviceId) audio.deviceId = { exact: deviceId };
    stream = await navigator.mediaDevices.getUserMedia({ audio });
    src = ctx.createMediaStreamSource(stream);
    const tr = stream.getAudioTracks()[0];
    tr.addEventListener('ended', () => { if (kind === 'mic') stopSource(); });
    const st = tr.getSettings ? tr.getSettings() : {};
    const proc = [['echoCancellation', 'echo cancel'], ['noiseSuppression', 'noise suppression'], ['autoGainControl', 'auto gain']];
    const known = proc.filter(([k]) => typeof st[k] === 'boolean');
    const on = known.filter(([k]) => st[k]).map(([, n]) => n);
    const procTxt = !known.length ? 'processing state unknown' : on.length ? 'processing ON: ' + on.join(', ') : 'processing off';
    began('mic', 'Mic: ' + (tr.label || 'default input') + (st.channelCount ? ' · ' + st.channelCount + ' ch' : '') + ' · ' + procTxt);
    listDevices(st.deviceId);
  } catch (e) { fail(e, 'mic'); }
}

async function listDevices(current) {
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
    const sel = $('#sDev');
    sel.innerHTML = '';
    devs.forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId; o.textContent = d.label || ('Input ' + (i + 1));
      if (d.deviceId === current) o.selected = true;
      sel.appendChild(o);
    });
    $('#devWrap').hidden = devs.length < 2;
  } catch (e) {}
}

const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
const canShare = !!navigator.mediaDevices?.getDisplayMedia && !isMobile;

async function startShare() {
  try {
    await ensureCtx();
    stopSource(true);
    setStatus('Pick a tab or screen and turn on “Share tab audio” / “Share system audio”.');
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { echoCancellation:false, noiseSuppression:false, autoGainControl:false },
      systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include', preferCurrentTab: false
    });
    const at = stream.getAudioTracks();
    if (!at.length) {
      stream.getTracks().forEach(t => t.stop()); stream = null;
      throw new Error('No audio came with the share. Share again and tick the audio checkbox. Firefox and Safari do not capture audio here; use Chrome or Edge.');
    }
    stream.getTracks().forEach(t => t.addEventListener('ended', () => { if (kind === 'share') stopSource(); }));
    src = ctx.createMediaStreamSource(new MediaStream(at));
    began('share', 'Shared audio: ' + (at[0].label || 'tab / system'));
  } catch (e) { fail(e, 'share'); }
}

async function startFile(file) {
  try {
    await ensureCtx();
    stopSource(true);
    mediaUrl = URL.createObjectURL(file);
    mediaEl = document.createElement('audio');
    mediaEl.controls = true; mediaEl.src = mediaUrl; mediaEl.loop = true;
    const bar = $('#filebar'); bar.innerHTML = ''; bar.appendChild(mediaEl); bar.hidden = false;
    src = ctx.createMediaElementSource(mediaEl);
    toDest = true;
    began('file', 'File: ' + file.name);
    await mediaEl.play();
  } catch (e) { fail(e, 'file'); }
}

function fail(e, k) {
  stopSource(true);
  let t = e && e.message ? e.message : String(e);
  if (e && e.name === 'NotAllowedError') t = k === 'share' ? 'Sharing was cancelled or blocked.' : 'Microphone permission was denied. Allow it in the site settings and try again.';
  if (e && e.name === 'NotFoundError') t = 'No input device was found.';
  setStatus(t, true);
}

/* ---------- wake lock ---------- */
async function requestWake() { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch (e) { wakeLock = null; } }
function releaseWake() { try { wakeLock?.release(); } catch (e) {} wakeLock = null; }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && kind) requestWake(); });

/* ---------- layout ---------- */
function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const r = specCv.getBoundingClientRect();
  const W = Math.max(50, r.width), H = Math.max(50, r.height);
  specCv.width = Math.round(W * dpr); specCv.height = Math.round(H * dpr);
  const narrow = W < 520;
  L = { W, H, dpr, pl: narrow ? 34 : 42, pr: 10, pt: 10, pb: 22, narrow };
  L.pw = W - L.pl - L.pr; L.ph = H - L.pt - L.pb;
  L.N = Math.max(2, Math.round(L.pw));
  L.R = fmax / FMIN;
  if (disp.length !== (S.mode === 'line' ? L.N + 1 : bands.length)) {
    const n = S.mode === 'line' ? L.N + 1 : bands.length;
    disp = new Float32Array(n).fill(-999); hold = new Float32Array(n).fill(-999); low = new Uint8Array(n);
  }
  buildGrid();
  if (S.sg) layoutSg();
  dirty = true;
}
const xOfF = f => L.pl + L.pw * Math.log(f / FMIN) / Math.log(L.R);
const fOfX = x => FMIN * Math.pow(L.R, (x - L.pl) / L.pw);
const yOfDb = d => L.pt + L.ph * Math.min(1, Math.max(0, d / S.floor));

function buildGrid() {
  const { W, H, dpr, pl, pt, pw, ph, narrow } = L;
  gridCv = gridCv || document.createElement('canvas');
  gridCv.width = specCv.width; gridCv.height = specCv.height;
  const g = gridCv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const cs = getComputedStyle(document.documentElement);
  const edge = cs.getPropertyValue('--edge').trim(), muted = cs.getPropertyValue('--muted').trim();
  g.font = '11px ' + cs.getPropertyValue('--f-num');
  g.textBaseline = 'middle';
  // vertical frequency lines
  for (let dec = 10; dec <= 10000; dec *= 10) {
    for (let m = 1; m < 10; m++) {
      const f = dec * m;
      if (f < FMIN || f > fmax) continue;
      const x = Math.round(xOfF(f)) + 0.5;
      g.strokeStyle = edge; g.globalAlpha = m === 1 ? 1 : 0.45;
      g.beginPath(); g.moveTo(x, pt); g.lineTo(x, pt + ph); g.stroke();
    }
  }
  g.globalAlpha = 1; g.fillStyle = muted; g.textAlign = 'center';
  const labs = narrow ? [50, 100, 500, 1000, 5000, 10000] : [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
  labs.forEach(f => { if (f <= fmax) g.fillText(f >= 1000 ? (f / 1000) + 'k' : String(f), Math.min(W - 14, Math.max(pl + 8, xOfF(f))), pt + ph + 12); });
  // horizontal level lines
  g.textAlign = 'right';
  const step = 10, lab = (L.ph < 220 || -S.floor > 100) ? 20 : 10;
  for (let d = 0; d >= S.floor; d -= step) {
    const y = Math.round(yOfDb(d)) + 0.5;
    g.strokeStyle = edge; g.globalAlpha = d % lab === 0 ? 1 : 0.45;
    g.beginPath(); g.moveTo(pl, y); g.lineTo(pl + pw, y); g.stroke();
    if (d % lab === 0) { g.globalAlpha = 1; g.fillText(String(d), pl - 6, Math.max(pt + 5, y)); }
  }
  g.globalAlpha = 1; g.textAlign = 'left';
  g.fillText('dBFS' + (S.slope ? ' · ' + S.slope + ' dB/oct' : ''), pl + 6, pt + 8);
}

/* ---------- spectrogram ---------- */
let sgLut = null, sgCol = null;
function buildLut() {
  const stops = [[0, [10, 13, 19]], [0.28, [24, 38, 86]], [0.52, [140, 44, 118]], [0.78, [255, 160, 60]], [1, [255, 246, 224]]];
  sgLut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255; let j = 0;
    while (j < stops.length - 2 && t > stops[j + 1][0]) j++;
    const [t0, c0] = stops[j], [t1, c1] = stops[j + 1], u = (t - t0) / (t1 - t0);
    for (let c = 0; c < 3; c++) sgLut[i * 3 + c] = c0[c] + (c1[c] - c0[c]) * u;
  }
}
function layoutSg() {
  const r = sgCv.getBoundingClientRect(), dpr = L.dpr;
  sgCv.width = Math.round(Math.max(50, r.width) * dpr); sgCv.height = Math.round(Math.max(20, r.height) * dpr);
  L.sgH = r.height;
  gx.setTransform(1, 0, 0, 1, 0, 0);
  gx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  gx.fillRect(0, 0, sgCv.width, sgCv.height);
  sgCol = gx.createImageData(1, sgCv.height);
  // frequency labels in the fixed left gutter
  const cs = getComputedStyle(document.documentElement);
  gx.setTransform(dpr, 0, 0, dpr, 0, 0);
  gx.fillStyle = cs.getPropertyValue('--panel').trim();
  gx.fillRect(0, 0, L.pl, r.height);
  gx.fillStyle = cs.getPropertyValue('--muted').trim();
  gx.font = '11px ' + cs.getPropertyValue('--f-num'); gx.textAlign = 'right'; gx.textBaseline = 'middle';
  [100, 1000, 10000].forEach(f => {
    const y = r.height * (1 - Math.log(f / FMIN) / Math.log(L.R));
    if (y > 8 && y < r.height - 6) gx.fillText(f >= 1000 ? (f / 1000) + 'k' : String(f), L.pl - 6, y);
  });
  gx.setTransform(1, 0, 0, 1, 0, 0);
}
function drawSgColumn() {
  const h = sgCv.height, w = sgCv.width, x0 = Math.round(L.pl * L.dpr), x1 = w - Math.round(L.pr * L.dpr);
  if (x1 - x0 < 4 || !sgCol) return;
  gx.drawImage(sgCv, x0 + 1, 0, x1 - x0 - 1, h, x0, 0, x1 - x0 - 1, h);
  const d = sgCol.data, lr = Math.log(L.R), fl = S.floor;
  for (let y = 0; y < h; y++) {
    const a = (h - 1 - y) / h, b = (h - y) / h;
    const v = sampleDb(FMIN * Math.exp(lr * a), FMIN * Math.exp(lr * b)) + LINE_CAL + slopeAt(FMIN * Math.exp(lr * (a + b) / 2));
    const i = Math.max(0, Math.min(255, Math.round(255 * (1 - v / fl)))) * 3;
    d[y * 4] = sgLut[i]; d[y * 4 + 1] = sgLut[i + 1]; d[y * 4 + 2] = sgLut[i + 2]; d[y * 4 + 3] = 255;
  }
  gx.putImageData(sgCol, x1 - 1, 0);
}

/* ---------- spectrum sampling ---------- */
function binAt(i) { return dbw[i < 0 ? 0 : i >= nb ? nb - 1 : i]; }
function interp(x) {
  const i = Math.floor(x), t = x - i;
  const p0 = binAt(i - 1), p1 = binAt(i), p2 = binAt(i + 1), p3 = binAt(i + 2);
  const v = 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
  return Math.max(-200, Math.min(Math.max(p1, p2), v));
}
// max over bins whose centres fall in [lo, hi]; cubic interpolation where bins are sparser than pixels
function sampleDb(lo, hi) {
  const b0 = lo / binHz, b1 = hi / binHz;
  if (b1 - b0 < 1) return interp((b0 + b1) / 2);
  const a = Math.max(1, Math.ceil(b0)), b = Math.min(nb - 1, Math.floor(b1));
  if (b < a) return interp((b0 + b1) / 2);
  let m = -200;
  for (let k = a; k <= b; k++) if (dbw[k] > m) m = dbw[k];
  return m;
}

function computeSeries(dt) {
  if (S.mode === 'line') {
    for (let i = 0; i <= L.N; i++) {
      const x = L.pl + i * L.pw / L.N, half = 0.5 * L.pw / L.N;
      disp[i] = sampleDb(fOfX(x - half), fOfX(x + half)) + LINE_CAL + slopeAt(fOfX(x));
    }
  } else {
    for (let j = 0; j < bands.length; j++) {
      const B = bands[j], a = Math.ceil(B.lo / binHz), b = Math.ceil(B.hi / binHz) - 1;
      const tilt = slopeAt(B.fc);
      if (b - a + 1 < 3) { disp[j] = interp(B.fc / binHz) + LINE_CAL + tilt; low[j] = 1; continue; }
      let p = 0;
      for (let k = a; k <= b && k < nb; k++) p += Math.pow(10, dbw[k] / 10);
      disp[j] = p > 0 ? 10 * log10(p) + BAND_CAL + tilt : -200; low[j] = 0;
    }
  }
  if (S.peak !== 'off') {
    const dec = S.peak === 'decay' ? 20 * dt : 0;
    for (let i = 0; i < disp.length; i++) hold[i] = Math.max(disp[i], hold[i] - dec);
  }
}

function findPeak() {
  const ka = Math.max(2, Math.ceil(FMIN / binHz)), kb = Math.min(nb - 2, Math.floor(fmax / binHz));
  let k = ka, m = -Infinity;
  for (let i = ka; i <= kb; i++) if (dbw[i] > m) { m = dbw[i]; k = i; }
  const a = dbw[k - 1], b = dbw[k], c = dbw[k + 1], den = a - 2 * b + c;
  const p = den !== 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den)) : 0;
  return { f: (k + p) * binHz, db: b - 0.25 * (a - c) * p + LINE_CAL };
}

function timeStats() {
  let s = 0, pk = 0;
  for (let i = 0; i < tbuf.length; i++) { const v = tbuf[i]; s += v * v; const av = v < 0 ? -v : v; if (av > pk) pk = av; }
  const rms = Math.sqrt(s / tbuf.length);
  return { rms: rms > 0 ? 20 * log10(rms) + 3.0103 : -999, pk: pk > 0 ? 20 * log10(pk) : -999 };
}

/* ---------- drawing ---------- */
const css = getComputedStyle(document.documentElement);
const COL = { trace: css.getPropertyValue('--trace').trim(), hold: css.getPropertyValue('--hold').trim(), fg: css.getPropertyValue('--fg').trim(), panel: css.getPropertyValue('--panel').trim(), edge: css.getPropertyValue('--edge').trim() };

function draw() {
  const { W, H, dpr, pl, pt, pw, ph } = L;
  sx.setTransform(1, 0, 0, 1, 0, 0);
  sx.clearRect(0, 0, specCv.width, specCv.height);
  if (gridCv) sx.drawImage(gridCv, 0, 0);
  sx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (!kind) return drawCursor();
  sx.save();
  sx.beginPath(); sx.rect(pl, pt, pw, ph); sx.clip();
  const bottom = pt + ph;
  if (S.mode === 'line') {
    const step = pw / L.N;
    sx.beginPath();
    for (let i = 0; i <= L.N; i++) { const x = pl + i * step, y = yOfDb(disp[i]); i ? sx.lineTo(x, y) : sx.moveTo(x, y); }
    const grad = sx.createLinearGradient(0, pt, 0, bottom);
    grad.addColorStop(0, hexA(COL.trace, 0.32)); grad.addColorStop(1, hexA(COL.trace, 0.02));
    sx.lineJoin = 'round'; sx.strokeStyle = COL.trace; sx.lineWidth = 1.5; sx.stroke();
    sx.lineTo(pl + pw, bottom); sx.lineTo(pl, bottom); sx.closePath(); sx.fillStyle = grad; sx.fill();
    if (S.peak !== 'off') {
      sx.beginPath();
      for (let i = 0; i <= L.N; i++) { const x = pl + i * step, y = yOfDb(hold[i]); i ? sx.lineTo(x, y) : sx.moveTo(x, y); }
      sx.strokeStyle = hexA(COL.hold, 0.75); sx.lineWidth = 1; sx.stroke();
    }
  } else {
    for (let j = 0; j < bands.length; j++) {
      const B = bands[j], x0 = xOfF(B.lo), x1 = xOfF(Math.min(B.hi, fmax)), gap = Math.max(1, (x1 - x0) * 0.14);
      const y = yOfDb(disp[j]);
      sx.fillStyle = low[j] ? hexA(COL.trace, 0.35) : COL.trace;
      sx.fillRect(x0 + gap / 2, y, Math.max(1, x1 - x0 - gap), bottom - y);
      if (S.peak !== 'off' && hold[j] > S.floor) {
        sx.fillStyle = COL.hold; sx.fillRect(x0 + gap / 2, yOfDb(hold[j]) - 1, Math.max(1, x1 - x0 - gap), 2);
      }
    }
  }
  // peak marker
  if (peakInfo && peakInfo.db > S.floor + 3) {
    const x = xOfF(peakInfo.f), y = yOfDb(peakInfo.db + slopeAt(peakInfo.f));
    sx.fillStyle = COL.fg;
    sx.beginPath(); sx.moveTo(x, y - 9); sx.lineTo(x - 4, y - 15); sx.lineTo(x + 4, y - 15); sx.closePath(); sx.fill();
  }
  sx.restore();
  drawCursor();
}

function drawCursor() {
  if (!cursor) return;
  const { pl, pt, pw, ph, W } = L;
  const x = Math.max(pl, Math.min(pl + pw, cursor.x));
  const f = fOfX(x);
  let v = null, tv = null, label;
  if (kind) {
    if (S.mode === 'line') { v = disp[Math.round((x - pl) / pw * L.N)]; tv = v - slopeAt(f); }
    else { const B = bands.find(b => f >= b.lo && f < b.hi); if (B) { v = disp[bands.indexOf(B)]; tv = v - slopeAt(B.fc); } }
  }
  if (S.mode !== 'line' && kind) {
    const B = bands.find(b => f >= b.lo && f < b.hi);
    label = (B ? fmtF(B.fc) + ' band' : fmtF(f)) + (tv != null ? '  ' + fmtDb(tv) : '');
  } else label = fmtF(f) + (tv != null ? '  ' + fmtDb(tv) : '') + '  ' + noteOf(f);
  sx.strokeStyle = hexA(COL.fg, 0.5); sx.lineWidth = 1; sx.setLineDash([3, 3]);
  sx.beginPath(); sx.moveTo(Math.round(x) + 0.5, pt); sx.lineTo(Math.round(x) + 0.5, pt + ph); sx.stroke();
  if (v != null && v > S.floor) { const y = Math.round(yOfDb(v)) + 0.5; sx.beginPath(); sx.moveTo(pl, y); sx.lineTo(pl + pw, y); sx.stroke(); }
  sx.setLineDash([]);
  sx.font = '600 12px ' + css.getPropertyValue('--f-num');
  const tw = sx.measureText(label).width + 14;
  const bx = Math.min(W - tw - 6, Math.max(pl + 4, x + 8)), by = pt + 6;
  sx.fillStyle = hexA(COL.panel, 0.92); sx.strokeStyle = COL.edge;
  sx.fillRect(bx, by, tw, 22); sx.strokeRect(bx + 0.5, by + 0.5, tw - 1, 21);
  sx.fillStyle = COL.fg; sx.textBaseline = 'middle'; sx.textAlign = 'left';
  sx.fillText(label, bx + 7, by + 11.5);
}

function hexA(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
}

function readouts(ts) {
  if (!kind || !peakInfo) {
    ['#rFreq', '#rNote', '#rLvl', '#rRms', '#rSpk'].forEach(s => $(s).textContent = '—');
  } else {
    const ok = peakInfo.db > S.floor + 3;
    $('#rFreq').textContent = ok ? fmtF(peakInfo.f) : '—';
    $('#rNote').textContent = ok ? noteOf(peakInfo.f) : '—';
    $('#rLvl').textContent = ok ? fmtDb(peakInfo.db) : '—';
    $('#rRms').textContent = fmtDb(ts.rms);
    $('#rSpk').textContent = fmtDb(ts.pk);
  }
  $('#rRes').textContent = (binHz).toFixed(binHz < 10 ? 2 : 1) + ' Hz · ' + Math.round(S.fft / sr * 1000) + ' ms';
}

/* ---------- main loop ---------- */
let ts = { rms: -999, pk: -999 };
function frame(t) {
  requestAnimationFrame(frame);
  const dt = lastT ? Math.min(0.1, (t - lastT) / 1000) : 0; lastT = t;
  if (kind && analyser && !frozen) {
    analyser.getFloatFrequencyData(fbuf);
    analyser.getFloatTimeDomainData(tbuf);
    for (let k = 0; k < nb; k++) { const v = fbuf[k]; dbw[k] = v > -200 ? v : -200; }
    computeSeries(dt);
    peakInfo = findPeak();
    if (S.sg) drawSgColumn();
    dirty = true;
  }
  if (dirty) { draw(); dirty = false; }
  if (t - lastRO > 125) { lastRO = t; if (kind && !frozen) ts = timeStats(); readouts(ts); }
}

/* ---------- UI wiring ---------- */
function syncControls() {
  $('#sFft').value = String(S.fft); $('#sMode').value = S.mode; $('#sSlope').value = String(S.slope);
  $('#sPeak').value = S.peak; $('#sFloor').value = String(S.floor); $('#sChan').value = S.chan;
  $('#sSmooth').value = String(S.smooth); $('#vSmooth').textContent = S.smooth.toFixed(2); $('#sSg').value = S.sg ? '1' : '0';
}
function setSg(on) {
  S.sg = on; sgCv.hidden = !on; stage.classList.toggle('sg', on);
  if (!sgLut) buildLut();
  requestAnimationFrame(() => { layout(); });
}

$('#sFft').onchange = e => { S.fft = +e.target.value; save(); if (analyser) configureAnalyser(); else { binHz = sr / S.fft; } };
$('#sMode').onchange = e => { S.mode = e.target.value; save(); if (analyser) { buildBands(); } else buildBands(); disp = new Float32Array(0); layout(); };
$('#sSlope').onchange = e => { S.slope = +e.target.value; save(); resetHold(); buildGrid(); dirty = true; };
$('#sPeak').onchange = e => { S.peak = e.target.value; save(); resetHold(); dirty = true; };
$('#sFloor').onchange = e => { S.floor = +e.target.value; save(); buildGrid(); dirty = true; };
$('#sChan').onchange = e => { S.chan = e.target.value; save(); if (src) route(); resetHold(); };
$('#sSmooth').oninput = e => { S.smooth = +e.target.value; $('#vSmooth').textContent = S.smooth.toFixed(2); if (analyser) analyser.smoothingTimeConstant = S.smooth; save(); };
$('#sSg').onchange = e => { setSg(e.target.value === '1'); save(); };
$('#sDev').onchange = e => startMic(e.target.value);

btn.mic.onclick = () => startMic($('#devWrap').hidden ? undefined : $('#sDev').value);
btn.share.onclick = startShare;
btn.file.onclick = () => $('#fileIn').click();
$('#fileIn').onchange = e => { const f = e.target.files[0]; if (f) startFile(f); e.target.value = ''; };
$('#bStop').onclick = () => stopSource();
const bFreeze = $('#bFreeze');
function toggleFreeze() { frozen = !frozen; bFreeze.setAttribute('aria-pressed', String(frozen)); bFreeze.lastChild.textContent = frozen ? 'Frozen' : 'Freeze'; }
bFreeze.onclick = toggleFreeze;
document.addEventListener('keydown', e => {
  if (e.code === 'Space' && !/INPUT|SELECT|BUTTON/.test(document.activeElement.tagName)) { e.preventDefault(); toggleFreeze(); }
});

if (!canShare) {
  btn.share.disabled = true;
  btn.share.title = 'Tab and system audio capture needs a desktop browser (Chrome, Edge or Opera).';
}

// cursor readout: mouse hover, or touch-and-drag (stays after lifting; tap the readout strip area outside to clear)
specCv.addEventListener('pointermove', e => { if (e.pointerType === 'mouse' || e.buttons) { const r = specCv.getBoundingClientRect(); cursor = { x: e.clientX - r.left }; dirty = true; } });
specCv.addEventListener('pointerdown', e => {
  const r = specCv.getBoundingClientRect(), x = e.clientX - r.left;
  if (e.pointerType !== 'mouse' && cursor && Math.abs(cursor.x - x) < 14) { cursor = null; } else cursor = { x };
  specCv.setPointerCapture?.(e.pointerId); dirty = true;
});
specCv.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') { cursor = null; dirty = true; } });

new ResizeObserver(() => layout()).observe(stage);

syncControls();
if (S.sg) setSg(true);
buildBands();
layout();
readouts(ts);
requestAnimationFrame(frame);
})();
