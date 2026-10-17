import './style.css';
import { CONNECTIONS, LM, meanVisibility, offset, STRIDE, type PoseTrack } from './analysis/landmarks';
import {
  checkTiming, guessTiming, intervalHistogram, intervals, intervalStats, longestUniformRun, type HistogramBin, type TimingSettings,
} from './analysis/timing';
import { webCodecsSupport } from './media/decode';
import { demux, type ClipInfo } from './media/demux';
import type { ExtractionPath } from './media/frames';
import { countDuplicates, scanDuplicates, type ScanResult } from './media/scan';
import { Extractor } from './pose/extract';
import type { ModelVariant } from './pose/landmarker';
import { deleteSession, listSessions, saveSession, type ClipTags, type SessionRecord } from './store/db';
import { WakeLockKeeper } from './wakelock';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '–');
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

// ---------- persistent settings (per-device conveniences) ----------
const SETTINGS_KEY = 'runform.settings';
interface Settings { model: ModelVariant; dupThreshold: number; speedUnit: string }
function loadSettings(): Settings {
  const d: Settings = { model: 'heavy', dupThreshold: 3, speedUnit: 'kmh' };
  try { return { ...d, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') }; } catch { return d; }
}
function storeSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage unavailable */ }
}
const settings = loadSettings();

// ---------- state ----------
let clip: ClipInfo | null = null;
let scan: ScanResult | null = null;
let scanAbort: AbortController | null = null;
let wcSupport: { supported: boolean; reason: string } = { supported: false, reason: '' };
let trim = { start: 0, end: 0 };
let extractor: Extractor | null = null;
const wake = new WakeLockKeeper();

// ---------- rendering helpers ----------
function kv(table: HTMLElement, rows: Array<[string, string]>) {
  table.innerHTML = rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join('');
}

function renderHistogram(el: HTMLElement, bins: HistogramBin[], factor: number) {
  if (!bins.length) { el.textContent = 'No intervals.'; return; }
  const MAX_BINS = 14;
  let shown = bins;
  let other = 0;
  if (bins.length > MAX_BINS) {
    const top = [...bins].sort((a, b) => b.count - a.count).slice(0, MAX_BINS);
    const keep = new Set(top);
    shown = bins.filter((b) => keep.has(b));
    other = bins.filter((b) => !keep.has(b)).reduce((s, b) => s + b.count, 0);
  }
  const max = Math.max(...shown.map((b) => b.count));
  el.innerHTML =
    `<div class="bin muted"><span>media ms (real ms)</span><span></span><span class="cnt">count</span></div>` +
    shown
      .map((b) => `<div class="bin"><span>${fmt(b.ms, 3)} (${fmt(b.ms / factor, 3)})</span><span class="bar" style="width:${(100 * b.count) / max}%"></span><span class="cnt">${b.count}</span></div>`)
      .join('') +
    (other ? `<div class="bin muted"><span>${bins.length - shown.length} other bins</span><span></span><span class="cnt">${other}</span></div>` : '');
}

function timingSettings(): TimingSettings {
  return {
    captureFps: parseFloat($<HTMLInputElement>('capture-fps').value) || 30,
    slowmoFactor: parseFloat($<HTMLInputElement>('slowmo-factor').value) || 1,
  };
}

function chosenPath(): ExtractionPath {
  if ($<HTMLSelectElement>('path-select').value === 'seek') return 'seek';
  return wcSupport.supported ? 'webcodecs' : 'seek';
}

// ---------- import ----------
$('model-select').addEventListener('change', (e) => { settings.model = (e.target as HTMLSelectElement).value as ModelVariant; storeSettings(); });
$<HTMLSelectElement>('model-select').value = settings.model;
$<HTMLInputElement>('dup-threshold').value = String(settings.dupThreshold);
$('dup-threshold').addEventListener('change', (e) => {
  settings.dupThreshold = Math.max(0, parseFloat((e.target as HTMLInputElement).value) || 0);
  storeSettings();
  renderScan();
  renderWindow();
});

$('file-input').addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  await importFile(file);
});

async function importFile(file: File) {
  scanAbort?.abort();
  extractor?.cancel();
  extractor = null;
  scan = null;
  const st = $('import-status');
  st.textContent = `Reading ${file.name} (${(file.size / 1e6).toFixed(1)} MB)…`;
  for (const id of ['sec-diag', 'sec-timing', 'sec-tags', 'sec-process', 'sec-result']) $(id).hidden = true;
  try {
    clip = await demux(file);
  } catch (err) {
    st.innerHTML = `<span class="bad">Could not read file: ${esc(String(err))}</span>`;
    clip = null;
    return;
  }
  st.textContent = '';
  wcSupport = await webCodecsSupport(clip);
  renderDiagnostics();

  const allStats = intervalStats(intervals(clip.presTimeS));
  const guess = guessTiming(allStats.fps, clip.slowmoHints.length > 0);
  $<HTMLInputElement>('capture-fps').value = String(guess.captureFps);
  $<HTMLInputElement>('slowmo-factor').value = String(guess.slowmoFactor);
  $('timing-guess').textContent = `Detected: ${guess.reason}`;

  const tv = $<HTMLVideoElement>('trim-video');
  if (tv.src) URL.revokeObjectURL(tv.src);
  tv.src = URL.createObjectURL(file);

  for (const id of ['trim-start', 'trim-end', 'trim-start-num', 'trim-end-num']) {
    ($<HTMLInputElement>(id)).max = String(clip.nSamples - 1);
  }
  setTrim(0, clip.nSamples - 1, 'start');

  for (const id of ['sec-diag', 'sec-timing', 'sec-tags', 'sec-process']) $(id).hidden = false;
  renderPathTable();
  if (wcSupport.supported) void runScan();
  else $('scan-status').textContent = 'Duplicate scan needs WebCodecs, which cannot decode this codec here. Duplicates will be counted during seek-based extraction.';
}

function renderDiagnostics() {
  if (!clip) return;
  const c = clip;
  const st = intervalStats(intervals(c.presTimeS));
  let syncs = 0;
  for (let i = 0; i < c.nSamples; i++) syncs += c.isSync[i];
  kv($('diag-table'), [
    ['File', `${esc(c.file.name)} — ${(c.file.size / 1e6).toFixed(1)} MB`],
    ['Container brands', esc(c.brands.join(', '))],
    ['Codec', esc(c.codec)],
    ['Coded resolution', `${c.codedWidth}×${c.codedHeight}`],
    ['Rotation / display', `${c.rotation}° → ${c.width}×${c.height}`],
    ['Total video samples', String(c.nSamples)],
    ['Keyframes', String(syncs)],
    ['Track duration (file timeline)', `${fmt(c.durationS, 3)} s`],
    ['Container frame rate (samples ÷ duration)', `${fmt(c.nominalFps, 3)} fps`],
    ['Median interval → fps', `${fmt(st.medianS * 1000, 3)} ms → ${fmt(st.fps, 3)} fps`],
    ['Interval min / max', `${fmt(st.minS * 1000, 3)} / ${fmt(st.maxS * 1000, 3)} ms`],
    ['Intervals within ±5% of median', `${fmt(st.uniformFraction * 100, 1)} %`],
    ['Slow-mo metadata hints', c.slowmoHints.length ? esc(c.slowmoHints.join(', ')) : 'none found'],
    ['Audio track', c.hasAudio ? 'yes' : 'no'],
    ['WebCodecs', wcSupport.supported ? `<span class="ok">${esc(wcSupport.reason)}</span>` : `<span class="warn">${esc(wcSupport.reason)}</span>`],
  ]);
  renderHistogram($('diag-hist'), intervalHistogram(intervals(c.presTimeS), 0.25), 1);
}

// ---------- duplicate scan ----------
async function runScan() {
  if (!clip) return;
  scanAbort?.abort();
  const ctrl = new AbortController();
  scanAbort = ctrl;
  const prog = $<HTMLProgressElement>('scan-progress');
  prog.hidden = false;
  $('scan-cancel').hidden = false;
  $('scan-btn').hidden = true;
  const st = $('scan-status');
  try {
    scan = await scanDuplicates(clip, ctrl.signal, (done, total) => {
      prog.value = done / total;
      st.textContent = `Decoding all frames to hash them… ${done}/${total}`;
    });
  } catch (e) {
    if ((e as DOMException).name === 'AbortError') st.textContent = 'Scan cancelled.';
    else st.innerHTML = `<span class="bad">Scan failed: ${esc(String(e))}</span>`;
  } finally {
    if (scanAbort === ctrl) scanAbort = null;
    prog.hidden = true;
    $('scan-cancel').hidden = true;
    $('scan-btn').hidden = false;
  }
  renderScan();
  renderWindow();
}
$('scan-btn').addEventListener('click', () => void runScan());
$('scan-cancel').addEventListener('click', () => scanAbort?.abort());

function renderScan() {
  if (!clip || !scan) return;
  const n = countDuplicates(scan.diffMax, 0, clip.nSamples - 1, settings.dupThreshold);
  // Smallest diffs help judge whether the threshold is sensible.
  const finite = Array.from(scan.diffMax).filter(Number.isFinite).sort((a, b) => a - b);
  const pct = (q: number) => finite[Math.min(finite.length - 1, Math.floor(q * finite.length))];
  $('scan-status').innerHTML =
    `${scan.framesDecoded}/${clip.nSamples} frames decoded in ${fmt(scan.elapsedS, 1)} s.\n` +
    `<b>${n}</b> duplicate frame(s) (max pixel diff ≤ ${settings.dupThreshold}).\n` +
    `Frame-diff distribution (max pixel diff): min ${fmt(finite[0], 0)}, 1% ${fmt(pct(0.01), 0)}, 5% ${fmt(pct(0.05), 0)}, median ${fmt(pct(0.5), 0)}.`;
}

// ---------- timing & trim ----------
for (const id of ['capture-fps', 'slowmo-factor']) $(id).addEventListener('input', renderWindow);

function setTrim(start: number, end: number, focus: 'start' | 'end') {
  if (!clip) return;
  const max = clip.nSamples - 1;
  start = Math.max(0, Math.min(max - 1, Math.round(start)));
  end = Math.max(start + 1, Math.min(max, Math.round(end)));
  trim = { start, end };
  $<HTMLInputElement>('trim-start').value = String(start);
  $<HTMLInputElement>('trim-end').value = String(end);
  $<HTMLInputElement>('trim-start-num').value = String(start);
  $<HTMLInputElement>('trim-end-num').value = String(end);
  $('trim-start-out').textContent = `${start} @ ${fmt(clip.presTimeS[start], 3)} s`;
  $('trim-end-out').textContent = `${end} @ ${fmt(clip.presTimeS[end], 3)} s`;
  previewFrame(focus === 'start' ? start : end);
  renderWindow();
}

let previewPending: number | null = null;
let previewBusy = false;
function previewFrame(p: number) {
  if (!clip) return;
  previewPending = p;
  if (previewBusy) return;
  const tv = $<HTMLVideoElement>('trim-video');
  const go = () => {
    if (previewPending === null || !clip) { previewBusy = false; return; }
    const q = previewPending;
    previewPending = null;
    previewBusy = true;
    const t = clip.presTimeS[q];
    const next = clip.presTimeS[Math.min(clip.nSamples - 1, q + 1)];
    const done = () => { tv.removeEventListener('seeked', done); go(); };
    tv.addEventListener('seeked', done);
    tv.currentTime = t + Math.max(0, (next - t) * 0.25);
  };
  go();
}

$('trim-start').addEventListener('input', (e) => setTrim(+(e.target as HTMLInputElement).value, trim.end, 'start'));
$('trim-end').addEventListener('input', (e) => setTrim(trim.start, +(e.target as HTMLInputElement).value, 'end'));
$('trim-start-num').addEventListener('change', (e) => setTrim(+(e.target as HTMLInputElement).value, trim.end, 'start'));
$('trim-end-num').addEventListener('change', (e) => setTrim(trim.start, +(e.target as HTMLInputElement).value, 'end'));
document.querySelectorAll<HTMLButtonElement>('button[data-trim]').forEach((b) => {
  b.addEventListener('click', () => {
    const d = +b.dataset.delta!;
    if (b.dataset.trim === 'start') setTrim(trim.start + d, trim.end, 'start');
    else setTrim(trim.start, trim.end + d, 'end');
  });
});
$('trim-auto').addEventListener('click', () => {
  if (!clip) return;
  const r = longestUniformRun(clip.presTimeS, 0.05);
  setTrim(r.start, r.end, 'start');
});
$('trim-all').addEventListener('click', () => clip && setTrim(0, clip.nSamples - 1, 'start'));

function renderWindow() {
  if (!clip) return;
  const s = timingSettings();
  const { start, end } = trim;
  const iv = intervals(clip.presTimeS, start, end);
  const st = intervalStats(iv);
  const chk = checkTiming(clip.presTimeS, start, end, s);
  const dups = scan ? String(countDuplicates(scan.diffMax, start, end, settings.dupThreshold)) : 'not scanned';
  kv($('window-table'), [
    ['Frames', String(end - start + 1)],
    ['Duration (file timeline)', `${fmt(chk.mediaDurationS, 3)} s`],
    ['Duration (real time)', `<b>${fmt(chk.realDurationS, 3)} s</b>`],
    ['Median interval', `${fmt(st.medianS * 1000, 3)} ms media = ${fmt((st.medianS * 1000) / s.slowmoFactor, 3)} ms real`],
    ['Within ±5% of median', `${fmt(st.uniformFraction * 100, 1)} %${st.uniformFraction < 0.98 ? ' <span class="warn">(not uniform — check for speed ramps)</span>' : ''}`],
    ['Interval CV', fmt(st.cv, 4)],
    ['Duplicate frames in window', dups],
  ]);
  renderHistogram($('window-hist'), intervalHistogram(iv, 0.25), s.slowmoFactor);

  $('timing-readout').innerHTML =
    `File timeline fps in window: <b>${fmt(chk.windowMediaFps, 2)}</b> · slow-mo ×${fmt(s.slowmoFactor, 3)} → implied capture <b>${fmt(chk.impliedCaptureFps, 1)} fps</b> ` +
    `vs entered <b>${fmt(s.captureFps, 1)} fps</b> ` +
    (chk.ok ? '<span class="ok">✓ consistent</span>' : `<span class="bad">✗ ${fmt(chk.mismatch * 100, 1)}% mismatch</span>`) +
    `<br>1 s of file = ${fmt(1 / s.slowmoFactor, 4)} s real · 1 frame = ${fmt(1000 / s.captureFps, 3)} ms real`;
  renderPathTable();
}

// ---------- tags ----------
function tags(): ClipTags {
  const view = (document.querySelector('input[name=view]:checked') as HTMLInputElement).value as ClipTags['view'];
  const surface = (document.querySelector('input[name=surface]:checked') as HTMLInputElement).value as ClipTags['surface'];
  const v = parseFloat($<HTMLInputElement>('belt-speed').value);
  const unit = $<HTMLSelectElement>('speed-unit').value;
  const mps = unit === 'kmh' ? v / 3.6 : unit === 'mph' ? v * 0.44704 : v;
  return { view, surface, treadmillSpeedMps: surface === 'TREADMILL' && Number.isFinite(mps) ? mps : null };
}
document.querySelectorAll('input[name=surface]').forEach((r) =>
  r.addEventListener('change', () => { $('speed-row').hidden = tags().surface !== 'TREADMILL'; }));
$<HTMLSelectElement>('speed-unit').value = settings.speedUnit;
$('speed-unit').addEventListener('change', (e) => { settings.speedUnit = (e.target as HTMLSelectElement).value; storeSettings(); });

// ---------- extraction ----------
function renderPathTable() {
  if (!clip) return;
  const path = chosenPath();
  kv($('path-table'), [
    ['Path', path === 'webcodecs' ? 'WebCodecs VideoDecoder (every sample decoded)' : '<span class="warn">Seek fallback (currentTime + requestVideoFrameCallback, verified)</span>'],
    ['Why', esc(wcSupport.reason)],
    ['Window', `frames ${trim.start}–${trim.end} (${trim.end - trim.start + 1})`],
    ['Model', settings.model],
  ]);
}
$('path-select').addEventListener('change', renderPathTable);

$('run-btn').addEventListener('click', async () => {
  if (!clip) return;
  if (tags().surface === 'TREADMILL' && tags().treadmillSpeedMps === null) {
    if (!confirm('No treadmill speed entered. Continue anyway?')) return;
  }
  scanAbort?.abort();
  const ex = new Extractor({
    clip, path: chosenPath(), presStart: trim.start, presEnd: trim.end,
    timing: timingSettings(), model: settings.model, dupThreshold: settings.dupThreshold,
  });
  extractor = ex;
  const prog = $<HTMLProgressElement>('run-progress');
  const status = $('run-status');
  const preview = $<HTMLCanvasElement>('preview');
  $('sec-result').hidden = true;
  ex.onProgress = (p) => {
    prog.value = p.done / p.total;
    status.textContent =
      `${p.done}/${p.total} frames · ${fmt(p.fps, 1)} frames/s · ETA ${Number.isFinite(p.etaS) ? fmtDuration(p.etaS) : '…'}\n` +
      `Path: ${ex.stats.path} · ${ex.stats.model} on ${ex.stats.delegate} · wake lock: ${wake.status}`;
  };
  ex.onPreview = (cv, track, f) => drawPreview(preview, cv, track, f);
  ex.onState = (s) => {
    $('run-btn').hidden = s === 'running' || s === 'paused' || s === 'loading';
    $('pause-btn').hidden = s !== 'running';
    $('resume-btn').hidden = s !== 'paused';
    $('cancel-btn').hidden = !(s === 'running' || s === 'paused' || s === 'loading');
    if (s === 'loading') status.textContent = 'Loading pose model…';
    if (s === 'paused') status.textContent += '\nPaused. Tap Resume to continue from where it stopped.';
    if (s === 'cancelled') { status.textContent = 'Cancelled.'; void wake.disable(); }
    if (s === 'error') { status.innerHTML = `<span class="bad">Error: ${esc(String(ex.error))}</span>`; void wake.disable(); }
    if (s === 'done') { void wake.disable(); void finish(ex); }
  };
  await wake.enable();
  await ex.start();
});
$('pause-btn').addEventListener('click', () => extractor?.pause());
$('resume-btn').addEventListener('click', async () => { await wake.enable(); await extractor?.resume(); });
$('cancel-btn').addEventListener('click', () => extractor?.cancel());

// Pause when the page is hidden instead of silently losing progress.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && extractor?.state === 'running') extractor.pause();
});

function fmtDuration(s: number) {
  const m = Math.floor(s / 60);
  return m ? `${m} min ${Math.round(s % 60)} s` : `${Math.round(s)} s`;
}

function drawPreview(out: HTMLCanvasElement, src: HTMLCanvasElement, t: PoseTrack, f: number) {
  const scale = Math.min(1, 720 / Math.max(src.width, src.height));
  const w = Math.round(src.width * scale), h = Math.round(src.height * scale);
  if (out.width !== w || out.height !== h) { out.width = w; out.height = h; }
  const ctx = out.getContext('2d')!;
  ctx.drawImage(src, 0, 0, w, h);
  if (!t.detected[f]) return;
  const P = (lm: number) => [t.px[offset(f, lm, 0)] * scale, t.px[offset(f, lm, 1)] * scale] as const;
  ctx.lineWidth = 3;
  for (const [a, b] of CONNECTIONS) {
    const left = a % 2 === 1 && b % 2 === 1;
    ctx.strokeStyle = left ? '#22d3ee' : a % 2 === 0 && b % 2 === 0 ? '#f97316' : '#e5e7eb';
    const [ax, ay] = P(a), [bx, by] = P(b);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  }
  for (let i = 0; i < 33; i++) {
    const vis = t.px[f * STRIDE + i * 4 + 3];
    const [x, y] = P(i);
    ctx.fillStyle = vis > 0.5 ? '#fff' : '#ef4444';
    ctx.fillRect(x - 2, y - 2, 4, 4);
  }
}

async function finish(ex: Extractor) {
  if (!clip) return;
  const t = ex.track;
  let det = 0, dup = 0;
  for (let i = 0; i < t.nFrames; i++) { det += t.detected[i]; dup += t.duplicate[i]; }
  const vis = (a: number, b: number) => `L ${fmt(meanVisibility(t, a), 2)} / R ${fmt(meanVisibility(t, b), 2)}`;
  const record: SessionRecord = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    video: { name: clip.file.name, size: clip.file.size, lastModified: clip.file.lastModified, durationS: clip.durationS, nSamples: clip.nSamples, codec: clip.codec },
    tags: tags(),
    timing: timingSettings(),
    trim: { presStart: trim.start, presEnd: trim.end },
    extraction: ex.stats,
    dupThreshold: settings.dupThreshold,
    track: t,
  };
  let saved = '';
  try {
    await saveSession(record);
    saved = '<span class="ok">saved to this device</span>';
  } catch (e) {
    saved = `<span class="bad">save failed: ${esc(String(e))}</span>`;
  }
  kv($('result-table'), [
    ['Frames processed', `${t.nFrames}`],
    ['Pose detected', `${det} (${fmt((100 * det) / t.nFrames, 1)} %)`],
    ['Duplicate frames in window', String(dup)],
    ['Extraction path', ex.stats.path + (ex.stats.path === 'seek' ? ` (${ex.stats.unverifiedFrames} unverified seeks)` : '')],
    ['Model / delegate', `${ex.stats.model} / ${ex.stats.delegate}${ex.stats.gpuError ? ` <span class="warn">(GPU: ${esc(ex.stats.gpuError)})</span>` : ''}`],
    ['Processing time', `${fmtDuration(ex.stats.elapsedS)} (${fmt(t.nFrames / ex.stats.elapsedS, 1)} frames/s)${ex.stats.pauses ? `, paused ${ex.stats.pauses}×` : ''}`],
    ['Real-time span', `${fmt(t.realTimeS[t.nFrames - 1], 3)} s at ×${record.timing.slowmoFactor} slow-mo, ${record.timing.captureFps} fps capture`],
    ['Mean visibility heel', vis(LM.L_HEEL, LM.R_HEEL)],
    ['Mean visibility foot index', vis(LM.L_FOOT_INDEX, LM.R_FOOT_INDEX)],
    ['Mean visibility knee', vis(LM.L_KNEE, LM.R_KNEE)],
    ['Session', saved],
  ]);
  $('sec-result').hidden = false;
  void renderSessions();
}

// ---------- saved sessions ----------
async function renderSessions() {
  const el = $('sessions');
  let list: SessionRecord[] = [];
  try { list = await listSessions(); } catch (e) { el.textContent = `Storage unavailable: ${String(e)}`; return; }
  if (!list.length) { el.innerHTML = '<p class="muted">None yet.</p>'; return; }
  el.innerHTML = list.reverse().map((s) => {
    let det = 0;
    for (let i = 0; i < s.track.nFrames; i++) det += s.track.detected[i];
    return `<div class="session"><b>${esc(s.video.name)}</b> · ${new Date(s.createdAt).toLocaleString()}<br>` +
      `${s.tags.view} · ${s.tags.surface}${s.tags.treadmillSpeedMps ? ` @ ${fmt(s.tags.treadmillSpeedMps * 3.6, 1)} km/h` : ''} · ` +
      `${s.track.nFrames} frames (${det} with pose) · ${s.timing.captureFps} fps ×${s.timing.slowmoFactor} · ${s.extraction.path} · ${s.extraction.model}` +
      `<div class="row"><button type="button" data-del="${s.id}">Delete</button></div></div>`;
  }).join('');
  el.querySelectorAll<HTMLButtonElement>('button[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('Delete this session?')) return;
      await deleteSession(b.dataset.del!);
      void renderSessions();
    }));
}
void renderSessions();

// ---------- offline status ----------
function renderOnline() {
  $('offline-status').textContent = navigator.onLine ? '' : 'offline';
}
addEventListener('online', renderOnline);
addEventListener('offline', renderOnline);
renderOnline();
