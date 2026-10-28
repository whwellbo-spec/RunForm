import './style.css';
import { canRecord, recordRun, TARGET_STEPS } from './camera';
import { CONNECTIONS, offset, type PoseTrack } from './analysis/landmarks';
import { analyzeGait, type ContactEdit, type GaitResult } from './analysis/metrics';
import { poseReport, statusOfScore, type PoseReport } from './analysis/posemethod';
import { checkSlowmo, retime } from './analysis/slowmo';
import { checkTiming, guessTiming, intervals, intervalStats, longestUniformRun, snapFps, type TimingSettings } from './analysis/timing';
import { webCodecsSupport } from './media/decode';
import { demux, type ClipInfo } from './media/demux';
import type { ExtractionPath } from './media/frames';
import { Extractor } from './pose/extract';
import type { ModelVariant } from './pose/landmarker';
import {
  DEFAULT_RUNNER_ID, deleteSession, listRunners, listSessions, matchesVideoRef, saveRunner, saveSession,
  type ClipTags, type Runner, type SessionCache, type SessionRecord,
} from './store/db';
import { StrideChart } from './ui/chart';
import { compareHTML, type CompareRun } from './ui/compare';
import { Player, type EventKind } from './ui/player';
import { esc, reportHTML, wireReport } from './ui/report';
import { renderStills } from './ui/stills';
import { renderTrend } from './ui/trend';
import { WakeLockKeeper } from './wakelock';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '–');

// ---------- settings (per-device conveniences) ----------
const SETTINGS_KEY = 'runform.settings';
interface Settings {
  model: ModelVariant; speedUnit: string; heightCm: number; heightUnit: 'cm' | 'in';
  /** Remembered slo-mo capture rate (0 = normal speed). */ slowmo: number;
  runnerId: string;
}
function loadSettings(): Settings {
  const d: Settings = { model: 'heavy', speedUnit: 'mph', heightCm: 175, heightUnit: 'in', slowmo: 240, runnerId: DEFAULT_RUNNER_ID };
  try { return { ...d, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') }; } catch { return d; }
}
const settings = loadSettings();
function storeSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* unavailable */ } }

/** Longest analysis window by default, in real seconds. */
const MAX_DEFAULT_REAL_S = 8;
/** Longest window for an in-app recording (it already starts when running starts). */
const MAX_RECORDED_REAL_S = 12;
const DUP_THRESHOLD = 3;
/** Bump when scoring changes so cached history numbers are recomputed. */
const CACHE_V = 3;

// ---------- state ----------
let clip: ClipInfo | null = null;
let clipSource: 'camera' | 'file' = 'file';
let wcSupport = { supported: false, reason: '' };
let trim = { start: 0, end: 0 };
/** Frame rate of the file's own timeline (before any slow-mo conversion). */
let fileFps = 30;
let extractor: Extractor | null = null;
let player: Player | null = null;
let chart: StrideChart | null = null;
let cmpPlayers: Player[] = [];
let runners: Runner[] = [];
const wake = new WakeLockKeeper();

// ---------- navigation ----------
type ViewId = 'home' | 'setup' | 'run' | 'report' | 'compare';
let current: ViewId = 'home';
function show(v: ViewId, title = 'RunForm') {
  current = v;
  for (const id of ['home', 'setup', 'run', 'report', 'compare'] as ViewId[]) $(`v-${id}`).hidden = id !== v;
  $('back-btn').hidden = v === 'home' || v === 'run';
  $('topbar-title').textContent = title;
  document.body.classList.toggle('at-home', v === 'home');
  if (v !== 'report') { player?.destroy(); player = null; chart?.destroy(); chart = null; }
  if (v !== 'compare') { cmpPlayers.forEach((p) => p.destroy()); cmpPlayers = []; }
  if (v === 'home') {
    // Nothing keeps the video once you leave: drop the in-memory clip.
    clip = null;
    exitCompareMode();
  }
  scrollTo(0, 0);
}
$('back-btn').addEventListener('click', () => {
  if (current === 'setup' || current === 'report' || current === 'compare') { show('home'); void renderSessions(); }
});

// ---------- runners ----------
async function loadRunners() {
  runners = await listRunners();
  if (!runners.find((r) => r.id === DEFAULT_RUNNER_ID)) {
    const me: Runner = { id: DEFAULT_RUNNER_ID, name: 'Me', heightCm: settings.heightCm, createdAt: 0 };
    await saveRunner(me);
    runners.unshift(me);
  }
  if (!runners.find((r) => r.id === settings.runnerId)) { settings.runnerId = DEFAULT_RUNNER_ID; storeSettings(); }
}
const currentRunner = (): Runner => runners.find((r) => r.id === settings.runnerId) ?? runners[0];
const runnerOf = (rec: SessionRecord): Runner | undefined => runners.find((r) => r.id === (rec.runnerId ?? DEFAULT_RUNNER_ID));

function renderRunnerSelects() {
  const opts = runners.map((r) => `<option value="${esc(r.id)}"${r.id === settings.runnerId ? ' selected' : ''}>${esc(r.name)}</option>`).join('');
  $('runner-select').innerHTML = `${opts}<option value="__new">＋ New runner…</option>`;
  $('runner-filter').innerHTML = opts;
  $('runner-filter').hidden = runners.length < 2;
  renderHeight();
}

async function selectRunner(id: string) {
  if (id === '__new') {
    const name = prompt('Runner’s name')?.trim();
    if (!name) { renderRunnerSelects(); return; }
    const r: Runner = { id: crypto.randomUUID(), name, heightCm: currentRunner().heightCm, createdAt: Date.now() };
    await saveRunner(r);
    runners.push(r);
    id = r.id;
  }
  settings.runnerId = id;
  storeSettings();
  renderRunnerSelects();
}
$('runner-select').addEventListener('change', (e) => void selectRunner((e.target as HTMLSelectElement).value));
$('runner-filter').addEventListener('change', async (e) => { await selectRunner((e.target as HTMLSelectElement).value); void renderSessions(); });

// ---------- home ----------
if (canRecord()) {
  $('record-btn').hidden = false;
  $('import-label').classList.remove('btn-primary');
} else {
  $('import-label').classList.add('btn-primary');
}
$('record-btn').addEventListener('click', () => openSetup('record'));

$('file-input').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (file && await importFile(file, 'file')) openSetup('file');
});

let compareMode = false;
let compareSel: string[] = [];
function exitCompareMode() {
  compareMode = false;
  compareSel = [];
  $('compare-bar').hidden = true;
  $('compare-hint').hidden = true;
  $('compare-btn').textContent = 'Compare two runs';
}
$('compare-btn').addEventListener('click', () => {
  if (compareMode) { exitCompareMode(); void renderSessions(); return; }
  compareMode = true;
  compareSel = [];
  $('compare-btn').textContent = 'Cancel compare';
  $('compare-hint').hidden = false;
  $('compare-bar').hidden = false;
  ($('compare-go') as HTMLButtonElement).disabled = true;
  void renderSessions();
});
$('compare-go').addEventListener('click', async () => {
  if (compareSel.length !== 2) return;
  const all = await listSessions();
  const [a, b] = compareSel.map((id) => all.find((s) => s.id === id)!).sort((x, y) => x.createdAt - y.createdAt);
  exitCompareMode();
  openCompare(a, b);
});

/** Headline numbers for the history list and trend chart (recomputed when scoring changes). */
function cacheFor(rec: SessionRecord): SessionCache {
  const g = analyze(rec);
  const rep = poseReport(g);
  const metrics: Record<string, number> = {};
  for (const m of rep.metrics) metrics[m.def.id] = m.value;
  return { v: CACHE_V, score: rep.overall, metrics, speedMps: g.speed?.mps ?? null };
}

async function renderSessions() {
  const el = $('sessions');
  let all: SessionRecord[] = [];
  try { all = await listSessions(); } catch (e) { el.innerHTML = `<p class="empty">Couldn’t open saved runs: ${esc(String(e))}</p>`; return; }
  const runnerId = settings.runnerId;
  const list = all.filter((s) => (s.runnerId ?? DEFAULT_RUNNER_ID) === runnerId);
  // Refresh cached numbers after a scoring change.
  for (const s of list) {
    if (s.cache?.v === CACHE_V) continue;
    try { s.cache = cacheFor(s); s.score = s.cache.score; await saveSession(s); } catch (e) { console.warn('cache failed', e); }
  }
  $('compare-btn').hidden = list.length < 2;
  renderTrend($('progress'), list, (r) => void openReport(r, null));
  if (!list.length) { el.innerHTML = `<p class="empty">${esc(currentRunner().name === 'Me' ? 'Your' : `${currentRunner().name}’s`)} analyzed runs will show up here.</p>`; return; }
  el.innerHTML = [...list].reverse().map((s) => {
    const score = s.cache?.score ?? s.score ?? NaN;
    const st = Number.isFinite(score) ? statusOfScore(score) : '';
    const when = new Date(s.createdAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const view = s.tags.view === 'SAGITTAL' ? 'Side view' : 'Front view';
    const surf = s.tags.surface === 'TREADMILL' ? 'treadmill' : 'outdoors';
    const sp = s.cache?.speedMps ? ` · ${(s.cache.speedMps * 2.23694).toFixed(1)} mph` : '';
    const sel = compareSel.includes(s.id);
    return `<button type="button" class="session-card${sel ? ' selected' : ''}" data-id="${s.id}" ${compareMode ? `aria-pressed="${sel}"` : ''}>
      <span class="badge ${st}">${Number.isFinite(score) ? Math.round(score) : '–'}</span>
      <span><span class="when">${esc(when)}</span><br><span class="meta">${view} · ${surf}${sp}${s.video.source === 'camera' ? ' · recorded' : ''}</span></span>
      <span class="chev" aria-hidden="true">${compareMode ? (sel ? '✓' : '○') : '›'}</span></button>`;
  }).join('');
  el.querySelectorAll<HTMLButtonElement>('.session-card').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.id!;
    if (compareMode) {
      compareSel = compareSel.includes(id) ? compareSel.filter((x) => x !== id) : [...compareSel, id].slice(-2);
      ($('compare-go') as HTMLButtonElement).disabled = compareSel.length !== 2;
      ($('compare-go') as HTMLButtonElement).textContent = compareSel.length === 2 ? 'Compare these two' : `Pick ${2 - compareSel.length} more`;
      void renderSessions();
      return;
    }
    const rec = list.find((s) => s.id === id);
    if (rec) void openReport(rec, null);
  }));
}

// ---------- setup ----------
function setMode(mode: 'record' | 'file') {
  document.body.classList.toggle('record-mode', mode === 'record');
  $('record-intro').hidden = mode !== 'record';
  $('run-btn').textContent = mode === 'record' ? 'Open camera' : 'Analyze';
}

function openSetup(mode: 'record' | 'file') {
  setMode(mode);
  renderRunnerSelects();
  show('setup', mode === 'record' ? 'Record a run' : 'New analysis');
}

function timingSettings(): TimingSettings {
  return {
    captureFps: parseFloat($<HTMLInputElement>('capture-fps').value) || 30,
    slowmoFactor: parseFloat($<HTMLInputElement>('slowmo-factor').value) || 1,
  };
}
function chosenPath(): ExtractionPath {
  return $<HTMLSelectElement>('path-select').value === 'seek' || !wcSupport.supported ? 'seek' : 'webcodecs';
}

/** Presentation index of the first frame at or after real time t (s) from the start. */
function frameAtSeconds(c: ClipInfo, t: number): number {
  const t0 = c.presTimeS[0];
  let lo = 0, hi = c.nSamples - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (c.presTimeS[m] - t0 < t) lo = m + 1; else hi = m; }
  return lo;
}

async function importFile(file: File, source: 'camera' | 'file', window?: { startS: number; endS: number }): Promise<boolean> {
  extractor?.cancel();
  extractor = null;
  const st = $('import-status');
  st.textContent = `Opening ${file.name}…`;
  try {
    clip = await demux(file);
  } catch (err) {
    st.innerHTML = `<span class="bad">That file couldn’t be read as a video (${esc(String(err))}). Try saving it to Files and choosing it again.</span>`;
    clip = null;
    return false;
  }
  clipSource = source;
  st.textContent = '';
  wcSupport = await webCodecsSupport(clip);

  const allStats = intervalStats(intervals(clip.presTimeS));
  fileFps = snapFps(allStats.fps);
  const guess = guessTiming(allStats.fps, clip.slowmoHints.length > 0);
  console.info('[RunForm] clip timing', {
    name: file.name, source, codec: clip.codec, frames: clip.nSamples, durationS: clip.durationS, fileFps: allStats.fps,
    uniform: allStats.uniformFraction, slowmoHints: clip.slowmoHints, brands: clip.brands, guess,
  });

  // A file whose own timeline is already high-rate needs no conversion.
  // Anything ~30/60 fps may be retimed slo-mo: use the remembered choice
  // (the post-analysis stride check catches a wrong guess either way).
  $('slowmo-field').hidden = guess.kind === 'native-high-fps';
  if (guess.kind === 'native-high-fps') {
    applyTiming(guess.captureFps, 1);
  } else {
    setFilmedIn(guess.kind === 'retimed-slowmo' ? guess.captureFps : settings.slowmo);
  }

  const tv = $<HTMLVideoElement>('trim-video');
  previewBusy = false;
  previewPending = null;
  if (tv.src) URL.revokeObjectURL(tv.src);
  if (source === 'file') {
    tv.src = URL.createObjectURL(file);
    tv.load();
  } else {
    tv.removeAttribute('src');
  }
  for (const id of ['trim-start', 'trim-end']) $<HTMLInputElement>(id).max = String(clip.nSamples - 1);

  if (window && window.startS >= 0) {
    // The recorder knows when running started and when it had enough steps.
    const s = frameAtSeconds(clip, window.startS);
    const endS = window.endS > window.startS ? window.endS + 0.4 : clip.durationS;
    const e = Math.min(frameAtSeconds(clip, endS), s + Math.round(MAX_RECORDED_REAL_S * timingSettings().captureFps));
    setTrim(s, Math.max(s + 1, e), 'start');
  } else {
    bestSection();
  }
  renderDiagnostics();
  return true;
}

/** Set capture fps + slow-mo factor, sync the "Filmed in" choice and the warning. */
function applyTiming(captureFps: number, factor: number) {
  $<HTMLInputElement>('capture-fps').value = String(snapFps(captureFps));
  $<HTMLInputElement>('slowmo-factor').value = String(factor);
  syncSlowmoUI();
}

function syncSlowmoUI() {
  const s = timingSettings();
  const capture = s.slowmoFactor > 1 ? Math.round(s.captureFps) : 0;
  document.querySelectorAll<HTMLInputElement>('input[name=slowmo]').forEach((r) => { r.checked = +r.value === capture; });
  const warn = $('clip-warning');
  warn.hidden = s.captureFps >= 100;
  warn.textContent = `Treating this as a normal-speed ${Math.round(s.captureFps)} fps video. Foot contacts are only accurate to about ${Math.round(1000 / s.captureFps)} ms. If you filmed in slo-mo, pick it below.`;
}

document.querySelectorAll<HTMLInputElement>('input[name=slowmo]').forEach((r) => r.addEventListener('change', () => {
  if (!r.checked) return;
  const f = +r.value;
  settings.slowmo = f;
  storeSettings();
  setFilmedIn(f);
  bestSection();
}));

/** "Filmed in" choice: 0 = normal speed, else the slo-mo capture rate. */
function setFilmedIn(capture: number) {
  const factor = capture > fileFps ? capture / fileFps : 1;
  applyTiming(factor > 1 ? capture : fileFps, factor);
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
  if (clipSource === 'file') previewFrame(focus === 'start' ? start : end);
  renderClipLine();
}

let previewPending: number | null = null;
let previewBusy = false;
/**
 * Show frame p in the setup preview. iOS ignores a seek issued before the
 * video has metadata (no 'seeked' ever fires), so wait for metadata and time
 * out every step.
 */
function previewFrame(p: number) {
  if (!clip) return;
  previewPending = p;
  if (previewBusy) return;
  const tv = $<HTMLVideoElement>('trim-video');
  const go = () => {
    if (previewPending === null || !clip) { previewBusy = false; return; }
    previewBusy = true;
    if (tv.readyState < HTMLMediaElement.HAVE_METADATA) {
      let timer = 0;
      const ready = () => { clearTimeout(timer); tv.removeEventListener('loadedmetadata', ready); tv.removeEventListener('error', ready); go(); };
      tv.addEventListener('loadedmetadata', ready);
      tv.addEventListener('error', ready);
      timer = window.setTimeout(() => {
        tv.removeEventListener('loadedmetadata', ready); tv.removeEventListener('error', ready);
        previewBusy = false;
      }, 4000);
      return;
    }
    const q = previewPending;
    previewPending = null;
    const t = clip.presTimeS[q];
    const next = clip.presTimeS[Math.min(clip.nSamples - 1, q + 1)];
    let timer = 0;
    const done = () => { clearTimeout(timer); tv.removeEventListener('seeked', done); go(); };
    tv.addEventListener('seeked', done);
    timer = window.setTimeout(done, 1500);
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
  const perSec = settings.model === 'heavy' ? 12 : 20;
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
for (const id of ['capture-fps', 'slowmo-factor']) $(id).addEventListener('input', () => { syncSlowmoUI(); renderClipLine(); setTrim(trim.start, trim.end, 'start'); });

$<HTMLSelectElement>('model-select').value = settings.model;
$('model-select').addEventListener('change', (e) => { settings.model = (e.target as HTMLSelectElement).value as ModelVariant; storeSettings(); renderClipLine(); });

// Height belongs to the selected runner.
function renderHeight() {
  const h = runners.length ? currentRunner().heightCm : settings.heightCm;
  $<HTMLSelectElement>('height-unit').value = settings.heightUnit;
  const v = settings.heightUnit === 'in' ? Math.round((h / 2.54) * 2) / 2 : Math.round(h);
  const inp = $<HTMLInputElement>('height-input');
  inp.value = String(v);
  inp.min = settings.heightUnit === 'in' ? '40' : '100';
  inp.max = settings.heightUnit === 'in' ? '90' : '230';
}
$('height-unit').addEventListener('change', (e) => { settings.heightUnit = (e.target as HTMLSelectElement).value as 'cm' | 'in'; storeSettings(); renderHeight(); });
$('height-input').addEventListener('change', async (e) => {
  const v = parseFloat((e.target as HTMLInputElement).value);
  if (!Number.isFinite(v)) return;
  const cm = settings.heightUnit === 'in' ? v * 2.54 : v;
  if (cm >= 100 && cm <= 230) {
    const r = currentRunner();
    r.heightCm = cm;
    await saveRunner(r);
    if (r.id === DEFAULT_RUNNER_ID) { settings.heightCm = cm; storeSettings(); }
  }
  renderHeight();
});

// View / surface
function tags(): ClipTags {
  const view = (document.querySelector('input[name=view]:checked') as HTMLInputElement).value as ClipTags['view'];
  const surface = (document.querySelector('input[name=surface]:checked') as HTMLInputElement).value as ClipTags['surface'];
  const v = parseFloat($<HTMLInputElement>('belt-speed').value);
  const unit = $<HTMLSelectElement>('speed-unit').value;
  const mps = unit === 'kmh' ? v / 3.6 : v * 0.44704;
  return { view, surface, treadmillSpeedMps: surface === 'TREADMILL' && Number.isFinite(mps) && mps > 0 ? mps : null };
}
document.querySelectorAll('input[name=surface]').forEach((r) => r.addEventListener('change', () => { $('speed-row').hidden = tags().surface !== 'TREADMILL'; }));
document.querySelectorAll('input[name=view]').forEach((r) => r.addEventListener('change', () => {
  $('view-hint').textContent = tags().view === 'SAGITTAL'
    ? 'Side view is needed for the Pose, Fall and Pull scores.'
    : 'Front or back view checks crossover, hip drop and knee collapse. Film from the side for the Pose Method scores.';
}));
$<HTMLSelectElement>('speed-unit').value = settings.speedUnit;
$('speed-unit').addEventListener('change', (e) => { settings.speedUnit = (e.target as HTMLSelectElement).value; storeSettings(); });

// ---------- recording ----------
async function recordAndAnalyze() {
  const st = $('import-status');
  let rec: Awaited<ReturnType<typeof recordRun>>;
  try {
    rec = await recordRun();
  } catch (e) {
    show('home');
    st.innerHTML = `<span class="bad">${esc(String((e as Error).message ?? e))}</span>`;
    return;
  }
  if (!rec) return; // cancelled: stay on the setup screen
  console.info('[RunForm] recording', rec.result);
  const r = rec.result;
  const ok = await importFile(rec.file, 'camera', { startS: r.runStartS, endS: r.runEndS });
  if (!ok) { show('home'); return; }
  if (r.steps < TARGET_STEPS / 2) {
    st.textContent = '';
    $('record-intro').textContent = `Only ${r.steps} steps were counted, so the analysis may be thin. Analyzing what was recorded.`;
  }
  await startAnalysis(rec.file);
}

// ---------- processing ----------
$('run-btn').addEventListener('click', async () => {
  if (document.body.classList.contains('record-mode')) { await recordAndAnalyze(); return; }
  if (!clip) return;
  await startAnalysis(clip.file);
});

async function startAnalysis(file: File) {
  if (!clip) return;
  const ex = new Extractor({
    clip, path: chosenPath(), presStart: trim.start, presEnd: trim.end,
    timing: timingSettings(), model: settings.model, dupThreshold: DUP_THRESHOLD,
  });
  extractor = ex;
  const runTags = tags();
  const timing = timingSettings();
  const t0 = trim;
  const runner = currentRunner();
  const source = clipSource;
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
    if (s === 'cancelled') { void wake.disable(); if (source === 'camera') show('home'); else show('setup', 'New analysis'); }
    if (s === 'error') { void wake.disable(); status.innerHTML = `<span class="bad">Tracking stopped: ${esc(String(ex.error))}</span>`; }
    if (s === 'done') { void wake.disable(); void finish(ex, file, runTags, timing, t0, runner, source); }
  };
  await wake.enable();
  await ex.start();
}
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
  // Track pixels are full resolution; the work canvas may be smaller.
  const k = w / t.width;
  const P = (lm: number) => [t.px[offset(f, lm, 0)] * k, t.px[offset(f, lm, 1)] * k] as const;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  for (const [a, b] of CONNECTIONS) {
    if (a === 0 || b === 0) continue;
    ctx.strokeStyle = a % 2 === 1 && b % 2 === 1 ? '#5EC8F2' : a % 2 === 0 && b % 2 === 0 ? '#F5A04A' : '#E8EDF5';
    const [ax, ay] = P(a), [bx, by] = P(b);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  }
}

async function finish(ex: Extractor, file: File, runTags: ClipTags, timing: TimingSettings, win: { start: number; end: number }, runner: Runner, source: 'camera' | 'file') {
  if (!clip) return;
  $('run-status').textContent = 'Measuring your stride…';
  const rec: SessionRecord = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    video: { name: file.name, size: file.size, lastModified: file.lastModified, durationS: clip.durationS, nSamples: clip.nSamples, codec: clip.codec, source },
    tags: runTags,
    timing,
    trim: { presStart: win.start, presEnd: win.end },
    extraction: ex.stats,
    dupThreshold: DUP_THRESHOLD,
    track: ex.track,
    heightCm: runner.heightCm,
    runnerId: runner.id,
  };
  try {
    const g = analyze(rec);
    $('run-status').textContent = 'Drawing key moments…';
    try { rec.stills = await renderStills(file, rec.track, g); } catch (e) { console.warn('stills failed', e); }
    rec.cache = cacheFor(rec);
    rec.score = rec.cache.score;
  } catch (e) {
    console.error(e);
  }
  try { await saveSession(rec); } catch (e) { console.warn('save failed', e); }
  await openReport(rec, file);
}

// ---------- report ----------
function analyze(rec: SessionRecord, edits?: ContactEdit[] | null): GaitResult {
  const runner = runnerOf(rec);
  return analyzeGait(rec.track, rec.tags.view, {
    heightCm: rec.heightCm ?? runner?.heightCm ?? settings.heightCm,
    treadmill: rec.tags.surface === 'TREADMILL',
    beltSpeedMps: rec.tags.treadmillSpeedMps,
    contacts: edits === null ? undefined : (edits ?? rec.contactEdits),
  });
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
  /** Corrections in progress (not yet saved); undefined = none pending. */
  let pending: ContactEdit[] | null | undefined;
  const runnerName = runnerOf(rec)?.name ?? 'Me';
  const heightCm = rec.heightCm ?? runnerOf(rec)?.heightCm ?? settings.heightCm;
  const input = () => ({
    rep, g, stills: rec.stills ?? {}, createdAt: rec.createdAt, clipName: rec.video.name, hasVideo: !!file,
    videoDeleted: !file && rec.video.source === 'camera', heightCm, runnerName, notes,
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

  /** Save corrected contacts, redraw stills and the report. */
  const applyEdits = async () => {
    if (pending === undefined) return;
    rec.contactEdits = pending ?? undefined;
    pending = undefined;
    g = analyze(rec);
    rep = poseReport(g);
    if (file) { try { rec.stills = await renderStills(file, rec.track, g); } catch (e) { console.warn('stills failed', e); } }
    rec.cache = cacheFor(rec);
    rec.score = rec.cache.score;
    try { await saveSession(rec); } catch (e) { console.warn('save failed', e); }
    render();
    document.getElementById('player-slot')?.scrollIntoView({ block: 'start' });
  };

  const render = () => {
    $('report').innerHTML = reportHTML(input());
    wireReport($('report'));
    document.querySelectorAll<HTMLButtonElement>('.share-pdf').forEach((b) => b.addEventListener('click', () => void sharePdf(b)));
    $('delete-btn').addEventListener('click', async () => {
      if (!confirm('Delete this run? This can’t be undone.')) return;
      await deleteSession(rec.id);
      show('home');
      void renderSessions();
    });
    const reopen = document.getElementById('reopen-input') as HTMLInputElement | null;
    reopen?.addEventListener('change', async () => {
      const f = reopen.files?.[0];
      if (!f) return;
      if (!matchesVideoRef(rec.video, f)) {
        $('player-slot').insertAdjacentHTML('afterbegin', `<p class="callout callout-warn">That’s a different video from the one analyzed (${esc(rec.video.name)}).</p>`);
        return;
      }
      file = f;
      if (!rec.stills || !Object.keys(rec.stills).length) {
        try { rec.stills = await renderStills(f, rec.track, g); await saveSession(rec); } catch (e) { console.warn(e); }
      }
      render();
    });

    chart?.destroy();
    chart = new StrideChart(g);
    $('chart-slot').appendChild(chart.el);
    chart.onSeek = (f) => player?.seek(f);

    if (file) {
      if (!player || player.file !== file) {
        player?.destroy();
        player = new Player(file, rec.track, g, rec.timing.slowmoFactor, {
          editable: true,
          onFrame: (f) => chart?.setFrame(f),
          onEdit: (edits) => {
            pending = edits;
            const g2 = analyze(rec, edits);
            player?.setResult(g2);
            chart?.setResult(g2);
          },
          onDone: () => void applyEdits(),
        });
      } else {
        player.setResult(g);
      }
      $('player-slot').appendChild(player.el);
    }
  };
  render();
  showSlowmoCheck(rec, file);
  show('report', 'Your report');
}

/**
 * Compare the runner's stride rhythm with the slow-mo factor used. If the
 * cadence only makes sense at another factor, offer a one-tap fix: the
 * landmarks don't change, only the real-time stamps, so no re-tracking.
 */
function showSlowmoCheck(rec: SessionRecord, file: File | null) {
  if (rec.timing.captureFps / rec.timing.slowmoFactor >= 90) return; // file timeline is already real time
  let chk: ReturnType<typeof checkSlowmo> = null;
  try { chk = checkSlowmo(rec.track, rec.timing.slowmoFactor); } catch (e) { console.warn('slow-mo check failed', e); }
  console.info('[RunForm] stride check', chk);
  if (!chk || chk.suggestedFactor === null) return;
  const f = chk.suggestedFactor;
  const mediaFps = rec.timing.captureFps / rec.timing.slowmoFactor;
  const label = f === 1 ? 'normal speed' : `${Math.round(mediaFps * f)} fps slo-mo (${f}× slower)`;
  const el = document.createElement('div');
  el.className = 'callout callout-warn';
  el.innerHTML = `<b>The timing looks off.</b> At the current setting your cadence would be ${Math.round(chk.cadenceSpm)} steps/min, which isn’t possible while running. Treated as ${esc(label)} it’s ${Math.round(chk.suggestedCadenceSpm)} steps/min.
    <button type="button" class="btn btn-primary btn-block">Fix timing</button>`;
  el.querySelector('button')!.addEventListener('click', async () => {
    retime(rec.track, f);
    rec.timing = { captureFps: mediaFps * f, slowmoFactor: f };
    settings.slowmo = f > 1 ? Math.round(mediaFps * f) : 0;
    storeSettings();
    try {
      const g = analyze(rec);
      if (file) { try { rec.stills = await renderStills(file, rec.track, g); } catch (e) { console.warn('stills failed', e); } }
      rec.cache = cacheFor(rec);
      rec.score = rec.cache.score;
    } catch (e) { console.error(e); }
    try { await saveSession(rec); } catch (e) { console.warn('save failed', e); }
    player?.destroy();
    player = null;
    await openReport(rec, file);
    const realS = rec.track.realTimeS[rec.track.nFrames - 1];
    if (realS < 4) {
      $('report').insertAdjacentHTML('afterbegin', `<p class="callout callout-warn">Timing fixed. Only ${fmt(realS, 1)} s of running was analyzed, so numbers may be jumpy. For steadier results, analyze the clip again; slo-mo is now the default.</p>`);
    }
  });
  $('report').prepend(el);
}

// ---------- compare ----------
function openCompare(a: SessionRecord, b: SessionRecord) {
  const run = (rec: SessionRecord): CompareRun => { const g = analyze(rec); return { rec, g, rep: poseReport(g) }; };
  let A: CompareRun, B: CompareRun;
  try { A = run(a); B = run(b); } catch (e) {
    $('compare').innerHTML = `<p class="empty">Couldn’t compare these runs: ${esc(String(e))}</p>`;
    show('compare', 'Compare');
    return;
  }
  $('compare').innerHTML = compareHTML(A, B);
  show('compare', 'Compare runs');
  const files: Record<'A' | 'B', File | null> = { A: null, B: null };
  let kind: EventKind = 'ic';
  let idx = 0;
  const sync = () => {
    const n = Math.min(...cmpPlayers.map((p) => p.eventCount()));
    idx = Math.max(0, Math.min(n - 1, idx));
    cmpPlayers.forEach((p) => p.jumpToEvent(kind, idx));
    $('cmp-idx').textContent = `Stride ${idx + 1} of ${n}`;
  };
  const mount = () => {
    if (!files.A || !files.B) return;
    cmpPlayers.forEach((p) => p.destroy());
    cmpPlayers = [
      new Player(files.A, A.rec.track, A.g, A.rec.timing.slowmoFactor, { title: 'A' }),
      new Player(files.B, B.rec.track, B.g, B.rec.timing.slowmoFactor, { title: 'B' }),
    ];
    const slot = $('cmp-players');
    slot.innerHTML = '';
    cmpPlayers.forEach((p) => slot.appendChild(p.el));
    $('cmp-sync').hidden = false;
    setTimeout(sync, 400);
  };
  $('compare').querySelectorAll<HTMLLabelElement>('.cmp-pick').forEach((label) => {
    const which = label.dataset.run as 'A' | 'B';
    const input = label.querySelector('input')!;
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      if (!f) return;
      const rec = which === 'A' ? A.rec : B.rec;
      if (!matchesVideoRef(rec.video, f)) { label.insertAdjacentHTML('afterend', `<p class="callout callout-warn">That isn’t the video for run ${which} (${esc(rec.video.name)}).</p>`); return; }
      files[which] = f;
      label.classList.add('picked');
      label.firstChild!.textContent = `Video ${which} ready ✓`;
      mount();
    });
  });
  $('compare').querySelectorAll<HTMLButtonElement>('[data-sk]').forEach((b) => b.addEventListener('click', () => {
    kind = b.dataset.sk as EventKind;
    $('compare').querySelectorAll('[data-sk]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    sync();
  }));
  $('compare').querySelectorAll<HTMLButtonElement>('[data-sync]').forEach((b) => b.addEventListener('click', () => {
    const act = b.dataset.sync;
    if (act === 'prev') { idx--; sync(); }
    else if (act === 'next') { idx++; sync(); }
    else if (act === 'play') { sync(); cmpPlayers.forEach((p) => { p.setSpeed(0.25); p.play(); }); }
    else if (act === 'pause') cmpPlayers.forEach((p) => p.pause());
  }));
}

// ---------- boot ----------
function renderOnline() { $('offline-status').textContent = navigator.onLine ? '' : 'Offline'; }
addEventListener('online', renderOnline);
addEventListener('offline', renderOnline);
renderOnline();
document.body.classList.add('at-home');
void (async () => {
  try { await loadRunners(); } catch (e) { console.warn('runners failed', e); runners = [{ id: DEFAULT_RUNNER_ID, name: 'Me', heightCm: settings.heightCm, createdAt: 0 }]; }
  renderRunnerSelects();
  await renderSessions();
})();

if (import.meta.env.DEV && location.hash.startsWith('#demo')) {
  void import('./dev/demo').then(({ synthRunner }) => {
    const track = synthRunner({ cadence: 166, duty: 0.36, landingPx: 230, noise: 2 });
    const rec = {
      id: 'demo', createdAt: Date.now(),
      video: { name: 'IMG_4182.MOV', size: 1, lastModified: 0, durationS: 6, nSamples: track.nFrames, codec: 'hvc1', source: 'camera' },
      tags: { view: 'SAGITTAL', surface: 'TREADMILL', treadmillSpeedMps: 3.1 }, timing: { captureFps: 240, slowmoFactor: 1 },
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
    if (location.hash === '#demo-setup') { openSetup('record'); return; }
    void openReport(rec, null);
  });
}
