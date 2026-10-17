import './style.css';
import { CONNECTIONS, offset, type PoseTrack } from './analysis/landmarks';
import { analyzeGait, type GaitResult } from './analysis/metrics';
import { poseReport, type PoseReport } from './analysis/posemethod';
import { checkTiming, guessTiming, intervals, intervalStats, longestUniformRun, type TimingSettings } from './analysis/timing';
import { webCodecsSupport } from './media/decode';
import { demux, type ClipInfo } from './media/demux';
import type { ExtractionPath } from './media/frames';
import { Extractor } from './pose/extract';
import type { ModelVariant } from './pose/landmarker';
import { deleteSession, listSessions, matchesVideoRef, saveSession, type ClipTags, type SessionRecord } from './store/db';
import { Player } from './ui/player';
import { esc, reportHTML, statusOfScore, wireReport } from './ui/report';
import { renderStills } from './ui/stills';
import { WakeLockKeeper } from './wakelock';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '–');

// ---------- settings (per-device conveniences) ----------
const SETTINGS_KEY = 'runform.settings';
interface Settings { model: ModelVariant; speedUnit: string; heightCm: number; heightUnit: 'cm' | 'in' }
function loadSettings(): Settings {
  const d: Settings = { model: 'heavy', speedUnit: 'mph', heightCm: 175, heightUnit: 'in' };
  try { return { ...d, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') }; } catch { return d; }
}
const settings = loadSettings();
function storeSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* unavailable */ } }

/** Longest analysis window by default, in real seconds. */
const MAX_DEFAULT_REAL_S = 8;
const DUP_THRESHOLD = 3;

// ---------- state ----------
let clip: ClipInfo | null = null;
let wcSupport = { supported: false, reason: '' };
let trim = { start: 0, end: 0 };
let extractor: Extractor | null = null;
let player: Player | null = null;
const wake = new WakeLockKeeper();

// ---------- navigation ----------
type ViewId = 'home' | 'setup' | 'run' | 'report';
let current: ViewId = 'home';
function show(v: ViewId, title = 'RunForm') {
  current = v;
  for (const id of ['home', 'setup', 'run', 'report'] as ViewId[]) $(`v-${id}`).hidden = id !== v;
  $('back-btn').hidden = v === 'home' || v === 'run';
  $('topbar-title').textContent = title;
  document.body.classList.toggle('at-home', v === 'home');
  if (v !== 'report') { player?.destroy(); player = null; }
  scrollTo(0, 0);
}
$('back-btn').addEventListener('click', () => {
  if (current === 'setup' || current === 'report') { show('home'); void renderSessions(); }
});

// ---------- home ----------
$('file-input').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (file) await importFile(file);
});

async function renderSessions() {
  const el = $('sessions');
  let list: SessionRecord[] = [];
  try { list = await listSessions(); } catch (e) { el.innerHTML = `<p class="empty">Couldn’t open saved runs: ${esc(String(e))}</p>`; return; }
  if (!list.length) { el.innerHTML = '<p class="empty">Your analyzed runs will show up here.</p>'; return; }
  el.innerHTML = list.reverse().map((s) => {
    const score = s.score ?? quickScore(s);
    const st = Number.isFinite(score) ? statusOfScore(score) : '';
    const when = new Date(s.createdAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const view = s.tags.view === 'SAGITTAL' ? 'Side view' : 'Front view';
    const surf = s.tags.surface === 'TREADMILL' ? 'treadmill' : 'outdoors';
    return `<button type="button" class="session-card" data-id="${s.id}">
      <span class="badge ${st}">${Number.isFinite(score) ? Math.round(score) : '–'}</span>
      <span><span class="when">${esc(when)}</span><br><span class="meta">${view} · ${surf} · ${esc(s.video.name)}</span></span>
      <span class="chev" aria-hidden="true">›</span></button>`;
  }).join('');
  el.querySelectorAll<HTMLButtonElement>('.session-card').forEach((b) => b.addEventListener('click', () => {
    const rec = list.find((s) => s.id === b.dataset.id);
    if (rec) void openReport(rec, null);
  }));
}

function quickScore(s: SessionRecord): number {
  try { return poseReport(analyze(s)).overall; } catch { return NaN; }
}

// ---------- setup ----------
function timingSettings(): TimingSettings {
  return {
    captureFps: parseFloat($<HTMLInputElement>('capture-fps').value) || 30,
    slowmoFactor: parseFloat($<HTMLInputElement>('slowmo-factor').value) || 1,
  };
}
function chosenPath(): ExtractionPath {
  return $<HTMLSelectElement>('path-select').value === 'seek' || !wcSupport.supported ? 'seek' : 'webcodecs';
}

async function importFile(file: File) {
  extractor?.cancel();
  extractor = null;
  const st = $('import-status');
  st.textContent = `Opening ${file.name}…`;
  try {
    clip = await demux(file);
  } catch (err) {
    st.innerHTML = `<span class="bad">That file couldn’t be read as a video (${esc(String(err))}). Try saving it to Files and choosing it again.</span>`;
    clip = null;
    return;
  }
  st.textContent = '';
  wcSupport = await webCodecsSupport(clip);

  const allStats = intervalStats(intervals(clip.presTimeS));
  const guess = guessTiming(allStats.fps, clip.slowmoHints.length > 0);
  $<HTMLInputElement>('capture-fps').value = String(guess.captureFps);
  $<HTMLInputElement>('slowmo-factor').value = String(guess.slowmoFactor);

  const tv = $<HTMLVideoElement>('trim-video');
  if (tv.src) URL.revokeObjectURL(tv.src);
  tv.src = URL.createObjectURL(file);
  for (const id of ['trim-start', 'trim-end']) $<HTMLInputElement>(id).max = String(clip.nSamples - 1);

  const warn = $('clip-warning');
  warn.hidden = guess.captureFps >= 100;
  warn.textContent = `This looks like a normal-speed video (${Math.round(guess.captureFps)} fps). It will work, but foot contacts are only accurate to about ${Math.round(1000 / guess.captureFps)} ms. Slo-mo (240 fps) gives much better results.`;

  bestSection();
  renderDiagnostics();
  show('setup', 'New analysis');
}

function bestSection() {
  if (!clip) return;
  const r = longestUniformRun(clip.presTimeS, 0.05);
  const s = timingSettings();
  // Cap the default window to keep processing time reasonable, centred in the uniform run.
  const maxFrames = Math.round(MAX_DEFAULT_REAL_S * s.captureFps);
  let { start, end } = r;
  if (end - start + 1 > maxFrames) {
    const mid = Math.round((start + end) / 2);
    start = mid - Math.floor(maxFrames / 2);
    end = start + maxFrames - 1;
  }
  setTrim(start, end, 'start');
}

function setTrim(start: number, end: number, focus: 'start' | 'end') {
  if (!clip) return;
  const max = clip.nSamples - 1;
  start = Math.max(0, Math.min(max - 1, Math.round(start)));
  end = Math.max(start + 1, Math.min(max, Math.round(end)));
  trim = { start, end };
  $<HTMLInputElement>('trim-start').value = String(start);
  $<HTMLInputElement>('trim-end').value = String(end);
  const s = timingSettings();
  const real = (p: number) => (clip!.presTimeS[p] - clip!.presTimeS[0]) / s.slowmoFactor;
  $('trim-start-out').textContent = `${fmt(real(start), 2)} s`;
  $('trim-end-out').textContent = `${fmt(real(end), 2)} s`;
  previewFrame(focus === 'start' ? start : end);
  renderClipLine();
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

function renderClipLine() {
  if (!clip) return;
  const s = timingSettings();
  const frames = trim.end - trim.start + 1;
  const realS = (clip.presTimeS[trim.end] - clip.presTimeS[trim.start]) / s.slowmoFactor;
  const totalReal = clip.durationS / s.slowmoFactor;
  const perSec = settings.model === 'heavy' ? 9 : 16;
  const etaMin = Math.max(1, Math.round(frames / perSec / 60));
  const kind = s.captureFps >= 100 ? `${Math.round(s.captureFps)} fps slow-mo` : `${Math.round(s.captureFps)} fps`;
  $('clip-line').innerHTML = `<b>${kind}</b> · analyzing <b>${fmt(realS, 1)} s</b> of ${fmt(totalReal, 1)} s · about ${etaMin} min`;
  const chk = checkTiming(clip.presTimeS, trim.start, trim.end, s);
  $('timing-readout').innerHTML = chk.ok
    ? `Timing checks out: ${fmt(chk.impliedCaptureFps, 0)} fps capture.`
    : `<span class="bad">The file’s timing implies ${fmt(chk.impliedCaptureFps, 0)} fps, not ${fmt(s.captureFps, 0)}. Check the slow-mo factor.</span>`;
}

function renderDiagnostics() {
  if (!clip) return;
  const c = clip;
  const st = intervalStats(intervals(c.presTimeS));
  const rows: Array<[string, string]> = [
    ['Codec', esc(c.codec)],
    ['Size', `${c.width}×${c.height}`],
    ['Frames', String(c.nSamples)],
    ['File frame rate', `${fmt(st.fps, 1)} fps`],
    ['Even frame spacing', `${fmt(st.uniformFraction * 100, 0)}%`],
    ['Slow-mo metadata', c.slowmoHints.length ? 'found' : 'none'],
    ['Frame reading', wcSupport.supported ? 'Direct decode' : `Compatibility mode (${esc(wcSupport.reason)})`],
  ];
  $('diag-table').innerHTML = rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join('');
}

$('trim-start').addEventListener('input', (e) => setTrim(+(e.target as HTMLInputElement).value, trim.end, 'start'));
$('trim-end').addEventListener('input', (e) => setTrim(trim.start, +(e.target as HTMLInputElement).value, 'end'));
$('trim-auto').addEventListener('click', bestSection);
$('trim-all').addEventListener('click', () => clip && setTrim(0, clip.nSamples - 1, 'start'));
for (const id of ['capture-fps', 'slowmo-factor']) $(id).addEventListener('input', () => { renderClipLine(); setTrim(trim.start, trim.end, 'start'); });

$<HTMLSelectElement>('model-select').value = settings.model;
$('model-select').addEventListener('change', (e) => { settings.model = (e.target as HTMLSelectElement).value as ModelVariant; storeSettings(); renderClipLine(); });

// Height
function renderHeight() {
  $<HTMLSelectElement>('height-unit').value = settings.heightUnit;
  const v = settings.heightUnit === 'in' ? Math.round((settings.heightCm / 2.54) * 2) / 2 : Math.round(settings.heightCm);
  const inp = $<HTMLInputElement>('height-input');
  inp.value = String(v);
  inp.min = settings.heightUnit === 'in' ? '40' : '100';
  inp.max = settings.heightUnit === 'in' ? '90' : '230';
}
$('height-unit').addEventListener('change', (e) => { settings.heightUnit = (e.target as HTMLSelectElement).value as 'cm' | 'in'; storeSettings(); renderHeight(); });
$('height-input').addEventListener('change', (e) => {
  const v = parseFloat((e.target as HTMLInputElement).value);
  if (!Number.isFinite(v)) return;
  const cm = settings.heightUnit === 'in' ? v * 2.54 : v;
  if (cm >= 100 && cm <= 230) { settings.heightCm = cm; storeSettings(); }
  renderHeight();
});
renderHeight();

// View / surface
function tags(): ClipTags {
  const view = (document.querySelector('input[name=view]:checked') as HTMLInputElement).value as ClipTags['view'];
  const surface = (document.querySelector('input[name=surface]:checked') as HTMLInputElement).value as ClipTags['surface'];
  const v = parseFloat($<HTMLInputElement>('belt-speed').value);
  const unit = $<HTMLSelectElement>('speed-unit').value;
  const mps = unit === 'kmh' ? v / 3.6 : v * 0.44704;
  return { view, surface, treadmillSpeedMps: surface === 'TREADMILL' && Number.isFinite(mps) ? mps : null };
}
document.querySelectorAll('input[name=surface]').forEach((r) => r.addEventListener('change', () => { $('speed-row').hidden = tags().surface !== 'TREADMILL'; }));
document.querySelectorAll('input[name=view]').forEach((r) => r.addEventListener('change', () => {
  $('view-hint').textContent = tags().view === 'SAGITTAL'
    ? 'Side view is needed for the Pose, Fall and Pull scores.'
    : 'Front or back view checks crossover and hip drop. Film from the side for the Pose Method scores.';
}));
$<HTMLSelectElement>('speed-unit').value = settings.speedUnit;
$('speed-unit').addEventListener('change', (e) => { settings.speedUnit = (e.target as HTMLSelectElement).value; storeSettings(); });

// ---------- processing ----------
$('run-btn').addEventListener('click', async () => {
  if (!clip) return;
  const file = clip.file;
  const ex = new Extractor({
    clip, path: chosenPath(), presStart: trim.start, presEnd: trim.end,
    timing: timingSettings(), model: settings.model, dupThreshold: DUP_THRESHOLD,
  });
  extractor = ex;
  const runTags = tags();
  const timing = timingSettings();
  const t0 = trim;
  show('run', 'Analyzing');
  const status = $('run-status');
  const preview = $<HTMLCanvasElement>('preview');
  $('run-pct').textContent = '0';
  $('run-meter').style.width = '0%';
  status.textContent = 'Loading the body tracker…';
  ex.onProgress = (p) => {
    const pct = Math.floor((100 * p.done) / p.total);
    $('run-pct').textContent = String(pct);
    $('run-meter').style.width = `${pct}%`;
    const eta = Number.isFinite(p.etaS) ? (p.etaS > 90 ? `about ${Math.round(p.etaS / 60)} min left` : `about ${Math.max(5, Math.round(p.etaS / 5) * 5)} s left`) : 'estimating time…';
    status.textContent = `Tracking your body: frame ${p.done} of ${p.total}, ${eta}.`;
  };
  ex.onPreview = (cv, track, f) => drawPreview(preview, cv, track, f);
  ex.onState = (s) => {
    $('pause-btn').hidden = s !== 'running';
    $('resume-btn').hidden = s !== 'paused';
    if (s === 'paused') status.textContent = 'Paused. Tap Resume to carry on from here.';
    if (s === 'cancelled') { void wake.disable(); show('setup', 'New analysis'); }
    if (s === 'error') { void wake.disable(); status.innerHTML = `<span class="bad">Tracking stopped: ${esc(String(ex.error))}</span>`; }
    if (s === 'done') { void wake.disable(); void finish(ex, file, runTags, timing, t0); }
  };
  await wake.enable();
  await ex.start();
});
$('pause-btn').addEventListener('click', () => extractor?.pause());
$('resume-btn').addEventListener('click', async () => { await wake.enable(); await extractor?.resume(); });
$('cancel-btn').addEventListener('click', () => {
  if (extractor && (extractor.state === 'running' || extractor.state === 'paused' || extractor.state === 'loading')) extractor.cancel();
  else show('setup', 'New analysis');
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && extractor?.state === 'running') extractor.pause();
});

function drawPreview(out: HTMLCanvasElement, src: HTMLCanvasElement, t: PoseTrack, f: number) {
  const scale = Math.min(1, 720 / Math.max(src.width, src.height));
  const w = Math.round(src.width * scale), h = Math.round(src.height * scale);
  if (out.width !== w || out.height !== h) { out.width = w; out.height = h; }
  const ctx = out.getContext('2d')!;
  ctx.drawImage(src, 0, 0, w, h);
  if (!t.detected[f]) return;
  const P = (lm: number) => [t.px[offset(f, lm, 0)] * scale, t.px[offset(f, lm, 1)] * scale] as const;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  for (const [a, b] of CONNECTIONS) {
    if (a === 0 || b === 0) continue;
    ctx.strokeStyle = a % 2 === 1 && b % 2 === 1 ? '#5EC8F2' : a % 2 === 0 && b % 2 === 0 ? '#F5A04A' : '#E8EDF5';
    const [ax, ay] = P(a), [bx, by] = P(b);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  }
}

async function finish(ex: Extractor, file: File, runTags: ClipTags, timing: TimingSettings, win: { start: number; end: number }) {
  if (!clip) return;
  $('run-status').textContent = 'Measuring your stride…';
  const rec: SessionRecord = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    video: { name: file.name, size: file.size, lastModified: file.lastModified, durationS: clip.durationS, nSamples: clip.nSamples, codec: clip.codec },
    tags: runTags,
    timing,
    trim: { presStart: win.start, presEnd: win.end },
    extraction: ex.stats,
    dupThreshold: DUP_THRESHOLD,
    track: ex.track,
    heightCm: settings.heightCm,
  };
  try {
    const g = analyze(rec);
    const rep = poseReport(g);
    rec.score = rep.overall;
    rec.grade = rep.grade;
    $('run-status').textContent = 'Drawing key moments…';
    try { rec.stills = await renderStills(file, rec.track, g); } catch (e) { console.warn('stills failed', e); }
  } catch (e) {
    console.error(e);
  }
  try { await saveSession(rec); } catch (e) { console.warn('save failed', e); }
  await openReport(rec, file);
}

// ---------- report ----------
function analyze(rec: SessionRecord): GaitResult {
  return analyzeGait(rec.track, rec.tags.view, { heightCm: rec.heightCm ?? settings.heightCm });
}

async function openReport(rec: SessionRecord, file: File | null) {
  let g: GaitResult, rep: PoseReport;
  try {
    g = analyze(rec);
    rep = poseReport(g);
  } catch (e) {
    $('report').innerHTML = `<p class="empty">This run couldn’t be analyzed: ${esc(String(e))}</p>`;
    show('report', 'Report');
    return;
  }
  const notes: string[] = [];
  if (rec.timing.captureFps < 100) notes.push(`Filmed at ${Math.round(rec.timing.captureFps)} fps, so timing values are approximate.`);
  const input = () => ({
    rep, g, stills: rec.stills ?? {}, createdAt: rec.createdAt, clipName: rec.video.name, hasVideo: !!file, notes,
  });
  let sharing = false;
  const sharePdf = async (btn: HTMLButtonElement) => {
    if (sharing) return;
    sharing = true;
    const label = btn.textContent;
    const status = document.querySelector<HTMLElement>('.share-status');
    btn.textContent = 'Making PDF…';
    btn.disabled = true;
    try {
      const { buildReportPdf, pdfFileName } = await import('./ui/pdf');
      const { shareFile } = await import('./share');
      const blob = buildReportPdf({ ...input(), surface: rec.tags.surface });
      const score = Number.isFinite(rep.overall) ? `${Math.round(rep.overall)}/100` : '';
      const outcome = await shareFile(blob, pdfFileName(rec.createdAt), 'RunForm analysis', `My RunForm running analysis${score ? `: ${score}, ${rep.grade}` : ''}.`);
      if (status) status.textContent = outcome === 'downloaded' ? 'PDF downloaded.' : '';
    } catch (e) {
      console.error(e);
      if (status) status.innerHTML = `<span class="bad">Couldn’t share the PDF: ${esc(String(e))}</span>`;
    } finally {
      btn.textContent = label;
      btn.disabled = false;
      sharing = false;
    }
  };
  const render = () => {
    $('report').innerHTML = reportHTML(input());
    wireReport($('report'));
    document.querySelectorAll<HTMLButtonElement>('.share-pdf').forEach((b) => b.addEventListener('click', () => void sharePdf(b)));
    $('delete-btn').addEventListener('click', async () => {
      if (!confirm('Delete this run? This can’t be undone.')) return;
      await deleteSession(rec.id);
      show('home');
      document.body.classList.add('at-home');
void renderSessions();

if (import.meta.env.DEV && location.hash === '#demo') {
  void import('./dev/demo').then(({ synthRunner }) => {
    const track = synthRunner({ cadence: 166, duty: 0.36, landingPx: 230, noise: 2 });
    const rec = {
      id: 'demo', createdAt: Date.now(),
      video: { name: 'IMG_4182.MOV', size: 1, lastModified: 0, durationS: 6, nSamples: track.nFrames, codec: 'hvc1' },
      tags: { view: 'SAGITTAL', surface: 'TREADMILL', treadmillSpeedMps: null }, timing: { captureFps: 240, slowmoFactor: 1 },
      trim: { presStart: 0, presEnd: track.nFrames - 1 }, extraction: { delegate: 'GPU', model: 'heavy', path: 'webcodecs', unverifiedFrames: 0, elapsedS: 1, pauses: 0 },
      dupThreshold: 3, track, heightCm: 183,
    } as SessionRecord;
    const fake = (label: string) => {
      const c = document.createElement('canvas'); c.width = 540; c.height = 720;
      const x = c.getContext('2d')!; x.fillStyle = '#2a3852'; x.fillRect(0, 0, 540, 720);
      x.fillStyle = '#fff'; x.font = '40px sans-serif'; x.fillText(label, 40, 360);
      return c.toDataURL('image/jpeg', 0.8);
    };
    rec.stills = { landing: fake('landing'), pose: fake('pose'), fall: fake('fall') };
    void openReport(rec, null);
  });
}
    });
    const reopen = document.getElementById('reopen-input') as HTMLInputElement | null;
    reopen?.addEventListener('change', async () => {
      const f = reopen.files?.[0];
      if (!f) return;
      if (!matchesVideoRef(rec.video, f)) {
        const slot = $('player-slot');
        slot.insertAdjacentHTML('afterbegin', `<p class="callout callout-warn">That’s a different video from the one analyzed (${esc(rec.video.name)}).</p>`);
        return;
      }
      file = f;
      if (!rec.stills || !Object.keys(rec.stills).length) {
        try { rec.stills = await renderStills(f, rec.track, g); await saveSession(rec); } catch (e) { console.warn(e); }
      }
      render();
    });
    if (file) {
      player?.destroy();
      player = new Player(file, rec.track, g, rec.timing.slowmoFactor);
      $('player-slot').appendChild(player.el);
    }
  };
  render();
  show('report', 'Your report');
  if (rec.score === undefined && Number.isFinite(rep.overall)) {
    rec.score = rep.overall;
    rec.grade = rep.grade;
    try { await saveSession(rec); } catch { /* ignore */ }
  }
}

// ---------- boot ----------
function renderOnline() { $('offline-status').textContent = navigator.onLine ? '' : 'Offline'; }
addEventListener('online', renderOnline);
addEventListener('offline', renderOnline);
renderOnline();
document.body.classList.add('at-home');
void renderSessions();

if (import.meta.env.DEV && location.hash === '#demo') {
  void import('./dev/demo').then(({ synthRunner }) => {
    const track = synthRunner({ cadence: 166, duty: 0.36, landingPx: 230, noise: 2 });
    const rec = {
      id: 'demo', createdAt: Date.now(),
      video: { name: 'IMG_4182.MOV', size: 1, lastModified: 0, durationS: 6, nSamples: track.nFrames, codec: 'hvc1' },
      tags: { view: 'SAGITTAL', surface: 'TREADMILL', treadmillSpeedMps: null }, timing: { captureFps: 240, slowmoFactor: 1 },
      trim: { presStart: 0, presEnd: track.nFrames - 1 }, extraction: { delegate: 'GPU', model: 'heavy', path: 'webcodecs', unverifiedFrames: 0, elapsedS: 1, pauses: 0 },
      dupThreshold: 3, track, heightCm: 183,
    } as SessionRecord;
    const fake = (label: string) => {
      const c = document.createElement('canvas'); c.width = 540; c.height = 720;
      const x = c.getContext('2d')!; x.fillStyle = '#2a3852'; x.fillRect(0, 0, 540, 720);
      x.fillStyle = '#fff'; x.font = '40px sans-serif'; x.fillText(label, 40, 360);
      return c.toDataURL('image/jpeg', 0.8);
    };
    rec.stills = { landing: fake('landing'), pose: fake('pose'), fall: fake('fall') };
    void openReport(rec, null);
  });
}
