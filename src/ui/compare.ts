// Side-by-side comparison of two runs: metric changes and key moments.
import type { GaitResult } from '../analysis/metrics';
import { PILLARS, type PoseReport } from '../analysis/posemethod';
import type { SessionRecord } from '../store/db';
import { esc, fmtVal, mph, statusOfScore } from './report';

export interface CompareRun { rec: SessionRecord; g: GaitResult; rep: PoseReport }

const when = (r: SessionRecord) => new Date(r.createdAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

export function compareHTML(a: CompareRun, b: CompareRun): string {
  const head = (x: CompareRun, label: string) => {
    const sc = Number.isFinite(x.rep.overall) ? Math.round(x.rep.overall) : null;
    const sp = x.g.speed ? ` · ${mph(x.g.speed.mps).toFixed(1)} mph` : '';
    return `<div class="cmp-head"><span class="cmp-tag">${label}</span>
      <span class="badge ${sc === null ? '' : statusOfScore(sc)}">${sc ?? '–'}</span>
      <span><b>${esc(when(x.rec))}</b><br><span class="fine">${x.g.view === 'SAGITTAL' ? 'Side' : 'Front/back'}${esc(sp)}</span></span></div>`;
  };
  const sameView = a.g.view === b.g.view;
  const warn = sameView ? '' : '<p class="callout callout-warn">These runs were filmed from different angles, so only the shared measurements are compared.</p>';
  const speedWarn = a.g.speed && b.g.speed && Math.abs(a.g.speed.mps - b.g.speed.mps) > 0.3
    ? `<p class="callout callout-warn">The runs were at different speeds (${mph(a.g.speed.mps).toFixed(1)} vs ${mph(b.g.speed.mps).toFixed(1)} mph). Cadence, contact time and fall angle change with speed.</p>` : '';

  const rows = a.rep.metrics.map((ma) => {
    const mb = b.rep.metrics.find((x) => x.def.id === ma.def.id && x.def.view === ma.def.view);
    if (!mb) return '';
    const q = 10 ** ma.def.decimals;
    const d = Math.round((mb.value - ma.value) * q) / q;
    const better = !ma.def.infoOnly && Math.abs(mb.score - ma.score) > 2 ? (mb.score > ma.score ? 'up' : 'down') : '';
    const sign = d > 0 ? '+' : d < 0 ? '−' : '';
    const delta = Number.isFinite(d) ? `${sign}${fmtVal(ma.def, Math.abs(d)).replace('−', '')}` : '–';
    return `<tr><td>${esc(ma.def.label)}${ma.def.infoOnly ? '' : `<span class="rng">${esc(PILLARS[ma.def.pillar].name)}</span>`}</td>
      <td class="v">${fmtVal(ma.def, ma.value)}</td><td class="v">${fmtVal(mb.def, mb.value)}</td>
      <td class="v delta ${better}">${delta}${better === 'up' ? ' ▲' : better === 'down' ? ' ▼' : ''}</td></tr>`;
  }).join('');

  const kinds = (['landing', 'pose', 'fall'] as const).filter((k) => a.rec.stills?.[k] && b.rec.stills?.[k]);
  const stills = kinds.length ? `<h2 class="section-title">Key moments</h2>
    ${kinds.map((k) => `<div class="cmp-stills"><figure class="still"><img src="${a.rec.stills![k]}" alt="${k} before"/><figcaption><b>A</b>${esc(k === 'landing' ? 'Landing' : k === 'pose' ? 'The Pose' : 'The fall')}</figcaption></figure>
      <figure class="still"><img src="${b.rec.stills![k]}" alt="${k} after"/><figcaption><b>B</b>&nbsp;</figcaption></figure></div>`).join('')}` : '';

  const videoSlot = (x: CompareRun, label: string) => x.rec.video.source === 'camera'
    ? `<p class="fine">Run ${label}: recorded in the app — video not kept.</p>`
    : `<label class="btn btn-block cmp-pick" data-run="${label}">Choose video ${label} (${esc(x.rec.video.name)})<input type="file" accept="video/*,.mov,.mp4,.m4v" /></label>`;
  const kept = a.rec.video.source !== 'camera' && b.rec.video.source !== 'camera';
  const watch = kept ? `<h2 class="section-title">Watch side by side</h2>
    <p class="fine">Pick both videos to play them together, lined up at the same moment of the stride.</p>
    ${videoSlot(a, 'A')}${videoSlot(b, 'B')}
    <div id="cmp-sync" class="controls" hidden>
      <div class="row">
        <button type="button" class="btn round" data-sync="prev" aria-label="Previous stride">‹</button>
        <span class="fine" id="cmp-idx">Stride 1</span>
        <button type="button" class="btn round" data-sync="next" aria-label="Next stride">›</button>
        <span class="grow"></span>
        <button type="button" class="chip" data-sk="ic" aria-pressed="true">Landing</button>
        <button type="button" class="chip" data-sk="ms" aria-pressed="false">Pose</button>
        ${sameView && a.g.view === 'SAGITTAL' ? '<button type="button" class="chip" data-sk="heelLift" aria-pressed="false">Fall</button>' : ''}
        <button type="button" class="chip" data-sk="to" aria-pressed="false">Toe-off</button>
      </div>
      <div class="row"><button type="button" class="btn" data-sync="play">Play both ¼×</button><button type="button" class="btn" data-sync="pause">Pause both</button></div>
    </div>
    <div id="cmp-players" class="cmp-players"></div>`
    : '<p class="fine">Side-by-side video needs both original videos. Runs recorded in the app don’t keep their video, so compare the key moments above instead.</p>';

  return `${head(a, 'A')}${head(b, 'B')}${warn}${speedWarn}
    <h2 class="section-title">What changed</h2>
    <table class="metrics cmp"><tr><th>Measurement</th><th class="v">A</th><th class="v">B</th><th class="v">Change</th></tr>${rows}</table>
    <p class="fine">▲ closer to the target range · ▼ further from it.</p>
    ${stills}${watch}`;
}
