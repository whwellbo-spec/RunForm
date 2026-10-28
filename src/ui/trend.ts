// Progress chart on the home screen: one value per run over time.
import { METRICS, statusOfScore } from '../analysis/posemethod';
import type { SessionRecord } from '../store/db';
import { esc, fixed } from './report';

export const TREND_METRICS: Array<{ id: string; label: string }> = [
  { id: 'score', label: 'Score' },
  { id: 'landing', label: 'Landing' },
  { id: 'cadence', label: 'Cadence' },
  { id: 'gct', label: 'Contact' },
  { id: 'vertOsc', label: 'Bounce' },
  { id: 'fall', label: 'Fall' },
];

const css = (name: string, fallback: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/** Render the progress card for side-view runs (oldest → newest). Returns '' markup if fewer than 2. */
export function renderTrend(el: HTMLElement, runs: SessionRecord[], onOpen: (r: SessionRecord) => void) {
  const pts = runs.filter((r) => r.tags.view === 'SAGITTAL' && r.cache).sort((a, b) => a.createdAt - b.createdAt);
  if (pts.length < 2) { el.innerHTML = ''; return; }
  let metric = 'score';
  try { metric = localStorage.getItem('runform.trend') ?? 'score'; } catch { /* unavailable */ }
  if (!TREND_METRICS.some((m) => m.id === metric)) metric = 'score';
  el.innerHTML = `<div class="trend">
    <div class="trend-chips">${TREND_METRICS.map((m) => `<button type="button" class="chip" data-m="${m.id}" aria-pressed="${m.id === metric}">${esc(m.label)}</button>`).join('')}</div>
    <canvas aria-label="Progress over time"></canvas>
    <p class="fine trend-note"></p>
  </div>`;
  const cv = el.querySelector('canvas')!;
  const note = el.querySelector<HTMLElement>('.trend-note')!;
  let hits: Array<{ x: number; y: number; r: SessionRecord }> = [];

  const draw = () => {
    const width = cv.clientWidth;
    if (!width) return;
    const H = 170, dpr = Math.min(2, devicePixelRatio || 1);
    cv.style.height = `${H}px`;
    cv.width = Math.round(width * dpr); cv.height = Math.round(H * dpr);
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const ink = css('--ink', '#14213D'), muted = css('--muted', '#5B6B82'), line = css('--line', '#D5DCE5');
    const def = METRICS.find((d) => d.id === metric && d.view === 'SAGITTAL');
    const val = (r: SessionRecord) => (metric === 'score' ? r.cache!.score : r.cache!.metrics[metric]);
    const data = pts.map((r) => ({ r, v: val(r) })).filter((d) => Number.isFinite(d.v));
    if (data.length < 2) { ctx.fillStyle = muted; ctx.font = '13px system-ui'; ctx.fillText('Not enough runs with this measurement yet.', 8, 24); note.textContent = ''; hits = []; return; }
    let lo = Math.min(...data.map((d) => d.v)), hi = Math.max(...data.map((d) => d.v));
    if (metric === 'score') { lo = Math.min(lo, 40); hi = 100; }
    else if (def) { lo = Math.min(lo, def.good[0]); hi = Math.max(hi, def.good[1]); }
    const pad = (hi - lo) * 0.12 || 1;
    lo -= pad; hi += pad;
    const left = 36, right = 14, top = 10, bottom = 30;
    const w = width - left - right, h = H - top - bottom;
    // Spread evenly by run, not by date, so runs on the same day don't overlap.
    const X = (i: number) => left + (data.length === 1 ? w / 2 : (i / (data.length - 1)) * w);
    const Y = (v: number) => top + h - ((v - lo) / (hi - lo)) * h;
    ctx.clearRect(0, 0, width, H);
    // Target band.
    const band = metric === 'score' ? [85, 100] : def ? def.good : null;
    if (band) {
      ctx.fillStyle = css('--green', '#1F7A55');
      ctx.globalAlpha = 0.12;
      ctx.fillRect(left, Y(band[1]), w, Y(band[0]) - Y(band[1]));
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = line; ctx.lineWidth = 1;
    ctx.font = '11px -apple-system, system-ui, sans-serif'; ctx.fillStyle = muted;
    for (const v of [lo + pad, hi - pad]) {
      ctx.beginPath(); ctx.moveTo(left, Y(v)); ctx.lineTo(left + w, Y(v)); ctx.stroke();
      ctx.fillText(fixed(v, def?.decimals ?? 0), 2, Y(v) + 4);
    }
    ctx.strokeStyle = ink; ctx.lineWidth = 2;
    ctx.beginPath();
    data.forEach((d, i) => { if (i) ctx.lineTo(X(i), Y(d.v)); else ctx.moveTo(X(i), Y(d.v)); });
    ctx.stroke();
    hits = [];
    data.forEach((d, i) => {
      const x = X(i), y = Y(d.v);
      const st = metric === 'score' ? statusOfScore(d.v) : null;
      ctx.fillStyle = st === 'good' ? css('--green', '#1F7A55') : st === 'ok' ? css('--amber', '#B97C0C') : st === 'fix' ? css('--track', '#C8442B') : ink;
      ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
      hits.push({ x, y, r: d.r });
      ctx.fillStyle = muted;
      const date = new Date(d.r.createdAt).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
      const sp = d.r.cache!.speedMps;
      const lbl = sp ? `${date} · ${(sp * 2.23694).toFixed(1)}` : date;
      const tw = ctx.measureText(lbl).width;
      if (i === 0 || i === data.length - 1 || data.length <= 6) ctx.fillText(lbl, Math.max(0, Math.min(width - tw, x - tw / 2)), H - 10);
    });
    const first = data[0].v, last = data[data.length - 1].v;
    const unit = metric === 'score' ? '' : def?.unit === '°' ? '°' : ` ${def?.unit ?? ''}`;
    note.textContent = `${TREND_METRICS.find((m) => m.id === metric)!.label}: ${fixed(first, def?.decimals ?? 0)}${unit} → ${fixed(last, def?.decimals ?? 0)}${unit} over ${data.length} side-view runs. Labels show date · mph when known; green band = target. Tap a point to open that run.`;
  };

  el.querySelectorAll<HTMLButtonElement>('[data-m]').forEach((b) => b.addEventListener('click', () => {
    metric = b.dataset.m!;
    try { localStorage.setItem('runform.trend', metric); } catch { /* unavailable */ }
    el.querySelectorAll('[data-m]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    draw();
  }));
  cv.addEventListener('click', (e) => {
    const r = cv.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const hit = hits.find((p) => Math.hypot(p.x - x, p.y - y) < 18);
    if (hit) onOpen(hit.r);
  });
  requestAnimationFrame(draw);
}
