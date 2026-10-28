// Renders the analysis report.
import type { GaitResult } from '../analysis/metrics';
import {
  DRILLS, PILLARS, statusOfScore, type GeneralFinding, type MetricDef, type MetricResult, type Pillar, type PoseReport, type Ranges,
} from '../analysis/posemethod';
import type { Stills } from './stills';

export { statusOfScore };

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** toFixed without a negative zero ("-0"). */
export function fixed(v: number, d: number): string {
  const s = v.toFixed(d);
  return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s;
}

export function fmtVal(def: MetricDef, v: number): string {
  if (!Number.isFinite(v)) return '–';
  const n = fixed(v, def.decimals).replace('-', '−');
  return def.unit === '°' ? `${n}°` : `${n} ${def.unit}`;
}
const fmtNum = (def: MetricDef, v: number) => fixed(v, def.decimals).replace('-', '−');
export function rangeText(def: MetricDef, ranges?: Pick<Ranges, 'good'>): string {
  const [a, b] = ranges?.good ?? def.good;
  const u = def.unit === '°' ? '°' : ` ${def.unit}`;
  return `${fmtNum(def, a)} to ${fmtNum(def, b)}${u}`;
}

export const mph = (mps: number) => mps * 2.23694;

/** One line describing speed and how distances were scaled. */
export function scaleLine(g: GaitResult, heightCm: number): string {
  const parts: string[] = [];
  if (g.speed) parts.push(`${g.speed.source === 'belt' ? 'Treadmill' : 'Estimated speed'} ${mph(g.speed.mps).toFixed(1)} mph`);
  parts.push(g.scale.source === 'belt'
    ? 'distances measured from the belt speed'
    : `distances scaled from height (${Math.round(heightCm / 2.54)} in)`);
  return parts.join(' · ');
}

export interface ReportInput {
  rep: PoseReport;
  g: GaitResult;
  stills: Stills;
  createdAt: number;
  clipName: string;
  hasVideo: boolean;
  /** The video was recorded in the app and has been deleted. */
  videoDeleted: boolean;
  heightCm: number;
  runnerName: string;
  notes: string[];
}

const CONF_LABEL = { high: '', medium: 'Medium confidence', low: 'Low confidence — film again to confirm' } as const;

const sideText = (m: MetricResult, g: GaitResult) => {
  if (g.view !== 'SAGITTAL') return '';
  const near = g.nearSide === 'L' ? 'left' : 'right';
  if (m.scoredFrom === 'near') return `${near} leg`;
  if (m.scoredFrom === 'swing-near') return `${near} leg swinging`;
  return '';
};

export function exerciseHTML(f: GeneralFinding): string {
  return `<article class="general">
    <h3>${esc(f.title)}</h3>
    <p>${esc(f.detail)}</p>
    <p class="research"><b>Research</b> ${esc(f.research)}</p>
    ${f.exercises.map((e) => `<div class="exercise"><b>${esc(e.name)}</b><span>${esc(e.dose)}</span><p>${esc(e.how)}</p></div>`).join('')}
  </article>`;
}

export function reportHTML(r: ReportInput): string {
  const { rep, g, stills } = r;
  const overall = Number.isFinite(rep.overall) ? Math.round(rep.overall) : null;
  const heroImg = stills.pose ?? stills.landing;
  const date = new Date(r.createdAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

  const hero = `
    <div class="hero ${heroImg ? '' : 'hero-noimg'}">
      ${heroImg ? `<img src="${heroImg}" alt="Your stride at midstance with the tracked skeleton" />` : ''}
      <div class="hero-score">
        <div class="score-num">${overall ?? '–'}<small>/100</small></div>
        <div><div class="grade">${esc(rep.grade)}</div><div class="grade-sub">${g.view === 'SAGITTAL' ? 'Pose Method score' : 'Alignment score'} · ${esc(r.runnerName)} · ${esc(date)}</div></div>
      </div>
    </div>
    <p class="reliability rel-${rep.reliability.level}">${esc(rep.reliability.text)}</p>
    <p class="fine">${esc(scaleLine(g, r.heightCm))}</p>
    <p class="summary-line">${esc(rep.summary)}</p>
    <div class="btn-row"><button type="button" class="btn btn-primary share-pdf">Share as PDF</button></div>
    <p class="status share-status" role="status"></p>`;

  const order: Pillar[] = g.view === 'SAGITTAL' ? ['pose', 'fall', 'pull'] : ['align'];
  const lanes = `
    <div class="lanes">
      ${order.map((id, i) => {
        const p = rep.pillars.find((x) => x.id === id);
        if (!p) return '';
        const st = statusOfScore(p.score);
        const ms = rep.metrics.filter((m) => m.def.pillar === id && !m.def.infoOnly);
        return `<button type="button" class="lane" data-lane="${id}" aria-expanded="false">
          <span class="lane-no">${i + 1}</span>
          <span><span class="lane-name">${esc(PILLARS[id].name)}</span><span class="lane-blurb">${esc(PILLARS[id].blurb)}</span>
            <span class="lane-bar"><i class="fill-${st}" style="width:${Math.max(4, p.score)}%"></i></span></span>
          <span class="lane-score txt-${st}">${Math.round(p.score)}</span>
          <span class="lane-detail" hidden>${ms.map((m) => `<span class="fine"><span class="dot ${m.status}"></span>${esc(m.def.label)}: <b>${fmtVal(m.def, m.value)}</b></span>`).join('')}</span>
        </button>`;
      }).join('')}
    </div>`;

  const issueCard = (m: MetricResult) => `
    <article class="issue ${m.status}">
      ${m.confidence !== 'high' ? `<span class="conf conf-${m.confidence}">${CONF_LABEL[m.confidence]}</span>` : ''}
      <h3>${esc(m.advice!.finding)}</h3>
      <div class="numbers">
        <div>You<b>${fmtVal(m.def, m.value)}</b></div>
        <div>Pose range<b>${rangeText(m.def, m.ranges)}</b></div>
      </div>
      ${m.ranges.speedAdjusted ? '<p class="fine">Range adjusted for your speed.</p>' : ''}
      <p>${esc(m.advice!.why)}</p>
      <div class="cue">${esc(m.advice!.cue)}</div>
      <div class="drill-tags">${m.advice!.drills.map((d) => `<span class="drill-tag">${esc(DRILLS[d]?.name ?? d)}</span>`).join('')}</div>
      ${m.def.evidence ? `<details class="evidence"><summary>What general research says</summary><p>${esc(m.def.evidence)}</p></details>` : ''}
    </article>`;

  const issues = rep.issues.length
    ? `<h2 class="section-title">What to work on</h2>${rep.issues.slice(0, 3).map(issueCard).join('')}
       ${rep.issues.length > 3 ? `<p class="fine">${rep.issues.length - 3} smaller thing${rep.issues.length > 4 ? 's are' : ' is'} in the full list below.</p>` : ''}`
    : '';

  const strengths = rep.strengths.length
    ? `<h2 class="section-title">Already in the Pose range</h2><div class="strengths">${rep.strengths.map((m) => `<span class="strength">${esc(m.def.label)}</span>`).join('')}</div>`
    : '';

  const drills = `<h2 class="section-title">Pose drills for this week</h2>
    <p class="fine">Do these before an easy run, 2–3 times a week, then film yourself again.</p>
    ${rep.drills.map((d) => `<div class="drill"><h3>${esc(d.name)}<span>${esc(d.dose)}</span></h3><p>${esc(d.how)}</p></div>`).join('')}`;

  const general = rep.general.length
    ? `<h2 class="section-title">Beyond the Pose Method</h2>
       <p class="fine">From general running research — mostly the strength work that backs up the form changes above. Two short strength sessions a week is plenty.</p>
       ${rep.general.map(exerciseHTML).join('')}`
    : '';

  const caption: Record<string, [string, string]> = {
    landing: ['Landing', 'Where your foot touches down'],
    pose: ['The Pose', 'Support foot under the hips'],
    fall: ['The fall', 'Lean as the heel lifts'],
  };
  const stillKeys = (['landing', 'pose', 'fall'] as const).filter((k) => stills[k]);
  const moments = stillKeys.length
    ? `<h2 class="section-title">Key moments</h2><div class="stills">${stillKeys.map((k) =>
        `<figure class="still"><img src="${stills[k]}" alt="${caption[k][0]}" /><figcaption><b>${caption[k][0]}</b>${caption[k][1]}</figcaption></figure>`).join('')}</div>`
    : '';

  const reopen = r.videoDeleted
    ? '<p class="fine">This run was recorded in the app, and the video was deleted after the analysis. The key moments above and the chart below are kept.</p>'
    : `<p class="fine">Choose the same video again to watch it in slow motion with your skeleton drawn on top, or to fix foot contacts.</p>
      <label class="btn btn-block">Choose the video<input id="reopen-input" type="file" accept="video/*,.mov,.mp4,.m4v" /></label>`;
  const watch = `<h2 class="section-title">Watch it back</h2>
    <div id="player-slot">${r.hasVideo ? '' : reopen}</div>
    <h2 class="section-title">Stride timeline</h2>
    <div id="chart-slot"></div>
    ${g.contactsEdited ? '<p class="fine">Foot contacts on this run were corrected by hand.</p>' : ''}`;

  const byPillar = order.map((id) => {
    const ms = rep.metrics.filter((m) => m.def.pillar === id);
    if (!ms.length) return '';
    return `<tr><th colspan="2">${esc(PILLARS[id].name)}</th></tr>` + ms.map((m) => {
      const spread = Number.isFinite(m.sd) ? ` ± ${fmtNum(m.def, m.sd)}` : '';
      const who = sideText(m, g);
      const basis = m.n > 1 && m.n < 1000 ? `${who ? `${who}, ` : ''}${m.n} ${m.def.id === 'cadence' || m.def.id === 'stepLength' ? 'steps' : 'strides'}` : who;
      return `
      <tr><td><span class="dot ${m.def.infoOnly ? 'info' : m.status}"></span>${esc(m.def.label)}${m.confidence === 'low' && !m.def.infoOnly ? ' <span class="conf conf-low">low confidence</span>' : ''}<span class="rng">${esc(m.def.what)}</span></td>
      <td class="v"><b>${fmtVal(m.def, m.value)}</b><span class="lr">${esc(spread)}${basis ? ` · ${esc(basis)}` : ''}</span>
        ${g.view === 'FRONTAL' && Number.isFinite(m.L) && Number.isFinite(m.R) ? `<span class="lr">L ${fmtNum(m.def, m.L)} · R ${fmtNum(m.def, m.R)}</span>` : ''}
        <span class="rng">${m.def.infoOnly ? 'typical' : 'Pose'} ${rangeText(m.def, m.ranges)}${m.ranges.speedAdjusted ? ' at your speed' : ''}</span></td></tr>`;
    }).join('');
  }).join('');
  const table = `<h2 class="section-title">All measurements</h2><table class="metrics">${byPillar}</table>
    <p class="fine"><span class="dot good"></span>in range <span class="dot ok"></span>close <span class="dot fix"></span>work on it <span class="dot info"></span>for reference only. ± is the stride-to-stride spread.</p>`;

  const left = g.steps.filter((s) => s.side === 'L').length, right = g.steps.filter((s) => s.side === 'R').length;
  const about = `<h2 class="section-title">About this analysis</h2>
    <ul class="about">
      <li>${g.steps.length} foot contacts measured (${left} left, ${right} right) from ${esc(r.clipName)}.</li>
      ${g.view === 'SAGITTAL' ? `<li>Leg numbers use your ${g.nearSide === 'L' ? 'left' : 'right'} leg, the one nearer the camera. The far leg is partly hidden, so it only counts toward whole-body numbers like bounce and trunk lean. Film from the other side, or from behind, to check the other leg.</li>` : '<li>From the front or back both legs are visible, so left and right are compared directly.</li>'}
      <li>${g.scale.source === 'belt' ? 'Distances are measured from the treadmill belt speed, which is more accurate than estimating from height.' : 'Distances are scaled from your height, so they’re accurate to a few centimetres.'}</li>
      <li>Ranges are coaching guides based on the Pose Method. Cadence and contact time ranges move with your speed when it’s known; fall angle also changes with speed, so compare runs at a similar pace.</li>
      ${[...g.warnings, ...r.notes].map((w) => `<li class="bad">${esc(w)}</li>`).join('')}
    </ul>
    <div class="btn-row">
      <button type="button" class="btn share-pdf">Share as PDF</button>
      <button id="delete-btn" type="button" class="btn danger">Delete this run</button>
    </div>`;

  return hero + lanes + issues + strengths + drills + general + moments + watch + table + about;
}

export function wireReport(root: HTMLElement) {
  root.querySelectorAll<HTMLButtonElement>('.lane').forEach((b) => b.addEventListener('click', () => {
    const d = b.querySelector<HTMLElement>('.lane-detail')!;
    d.hidden = !d.hidden;
    b.setAttribute('aria-expanded', String(!d.hidden));
  }));
}
