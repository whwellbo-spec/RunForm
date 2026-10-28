// Per-step running metrics from kinematics + foot contacts. Pure, no DOM.
import { mean, medianOf, percentile, sd } from './filter';
import {
  buildKinematics, completeContact, DEG, detectContacts, fwd, hipX, hipY, jointAngle, kneeFlex, LEG, leanFromVertical, other,
  shoulderX, shoulderY, slope, stanceFootSpeedsPx, type Contact, type Kinematics, type KinematicsOptions, type Side,
} from './gait';
import type { PoseTrack } from './landmarks';

export type View = 'SAGITTAL' | 'FRONTAL';

export interface StepMetrics {
  side: Side;
  contact: Contact;
  values: Record<string, number>;
}

export interface Stat { mean: number; sd: number; n: number }
/** Which strides a metric's headline number is built from. */
export type ScoredFrom = 'near' | 'swing-near' | 'both';
export interface MetricSummary {
  L: Stat; R: Stat; all: Stat;
  /** The sample the headline value and score use (side view: the leg nearer the camera). */
  scored: Stat;
  scoredFrom: ScoredFrom;
  diff: number;
}

/** A hand-corrected contact: landing and toe-off frames in the track. */
export interface ContactEdit { side: Side; ic: number; to: number }

export interface AnalyzeOptions extends Partial<KinematicsOptions> {
  /** Treadmill belt speed (m/s). Used to calibrate distances in side view. */
  beltSpeedMps?: number | null;
  /** True for treadmill clips (no speed estimate from the runner crossing the frame). */
  treadmill?: boolean;
  /** Replace detected contacts with these (manual corrections). */
  contacts?: ContactEdit[];
}

export interface ScaleInfo {
  /** Where cm-per-pixel came from. */
  source: 'belt' | 'height';
  cmPerPx: number;
  heightCmPerPx: number;
  /** Belt-derived scale, when a belt speed was given and the foot speed could be measured. */
  beltCmPerPx: number;
  /** Speed implied by the video at the height-based scale (m/s), treadmill only. */
  impliedBeltMps: number;
}

export interface SpeedInfo {
  mps: number;
  source: 'belt' | 'estimated';
}

export interface GaitResult {
  view: View;
  kin: Kinematics;
  contacts: Contact[];
  contactsEdited: boolean;
  steps: StepMetrics[];
  summary: Record<string, MetricSummary>;
  cadenceSpm: number;
  /** Visibility of each leg's foot landmarks; in side view the far leg is lower. */
  footVisibility: Record<Side, number>;
  nearSide: Side;
  scale: ScaleInfo;
  speed: SpeedInfo | null;
  warnings: string[];
}

const stat = (v: number[]): Stat => ({ mean: mean(v), sd: sd(v), n: v.filter(Number.isFinite).length });
const EMPTY: Stat = { mean: NaN, sd: NaN, n: 0 };

/** Side view: metrics that describe the whole body, so both legs' strides count. */
const BOTH_LEGS = new Set(['trunk', 'vertOsc', 'flight', 'duty']);
/** Side view: metrics about the SWING leg at the support leg's midstance. */
const SWING_LEG = new Set(['poseSwing', 'poseHeight']);
/** Fewest strides before falling back to both legs. */
const MIN_NEAR = 3;

function footVis(k: Kinematics, s: Side): number {
  const L = LEG[s];
  let v = 0, c = 0;
  for (let f = 0; f < k.n; f++) if (k.detected[f]) { v += (k.vis[L.heel][f] + k.vis[L.toe][f] + k.vis[L.ankle][f]) / 3; c++; }
  return c ? v / c : 0;
}

/** Frontal-plane knee angle (deg): positive = knee collapses toward the midline (valgus). */
function kneeFrontal(k: Kinematics, s: Side, f: number): number {
  const S = LEG[s], O = LEG[other(s)];
  const inward = Math.sign(k.x[O.hip][f] - k.x[S.hip][f]) || 1;
  const hx = k.x[S.hip][f], hy = k.y[S.hip][f], ax = k.x[S.ankle][f], ay = k.y[S.ankle][f];
  const kx = k.x[S.knee][f], ky = k.y[S.knee][f];
  const u = ay !== hy ? (ky - hy) / (ay - hy) : 0.5;
  const lineX = hx + u * (ax - hx);
  const dev = 180 - jointAngle(k, S.hip, S.knee, S.ankle, f);
  return (kx - lineX) * inward >= 0 ? dev : -dev;
}

export function analyzeGait(track: PoseTrack, view: View, opts: AnalyzeOptions = {}): GaitResult {
  const kin = buildKinematics(track, opts);
  const warnings: string[] = [];
  if (kin.detectedFraction < 0.8) warnings.push(`A runner was found in only ${Math.round(kin.detectedFraction * 100)}% of frames.`);

  const requireBackward = view === 'SAGITTAL';
  const contactsEdited = !!opts.contacts;
  const contacts = (opts.contacts
    ? opts.contacts.filter((c) => c.ic >= 0 && c.to < kin.n && c.to > c.ic).map((c) => completeContact(kin, c.side, c.ic, c.to))
    : [...detectContacts(kin, 'L', { requireBackward }), ...detectContacts(kin, 'R', { requireBackward })]
  ).sort((a, b) => a.ic - b.ic);
  if (view === 'FRONTAL') for (const c of contacts) { c.ms = Math.round((c.ic + c.to) / 2); }

  const footVisibility = { L: footVis(kin, 'L'), R: footVis(kin, 'R') };
  const nearSide: Side = footVisibility.L >= footVisibility.R ? 'L' : 'R';

  // ---- scale: belt speed (treadmill, side view) or runner height ----
  const heightCmPerPx = kin.cmPerPx;
  const scale: ScaleInfo = { source: 'height', cmPerPx: heightCmPerPx, heightCmPerPx, beltCmPerPx: NaN, impliedBeltMps: NaN };
  if (view === 'SAGITTAL' && opts.treadmill) {
    const near = contacts.filter((c) => c.side === nearSide);
    const speeds = stanceFootSpeedsPx(kin, near.length >= MIN_NEAR ? near : contacts).filter((v) => v < 0).map((v) => -v);
    if (speeds.length >= 2) {
      const pxPerS = medianOf(speeds);
      scale.impliedBeltMps = (pxPerS * heightCmPerPx) / 100;
      const belt = opts.beltSpeedMps;
      if (belt && belt > 0.5) {
        scale.beltCmPerPx = (belt * 100) / pxPerS;
        const ratio = scale.beltCmPerPx / heightCmPerPx;
        if (ratio > 0.7 && ratio < 1.4) {
          scale.source = 'belt';
          scale.cmPerPx = scale.beltCmPerPx;
        } else {
          warnings.push(`The belt speed entered (${(belt * 2.23694).toFixed(1)} mph) doesn’t match the video, which looks closer to ${(scale.impliedBeltMps * 2.23694).toFixed(1)} mph. Distances use your height instead. Check the speed and the slo-mo setting.`);
        }
      }
    }
  }
  kin.cmPerPx = scale.cmPerPx;

  // ---- speed ----
  let speed: SpeedInfo | null = null;
  if (opts.treadmill) {
    if (opts.beltSpeedMps && opts.beltSpeedMps > 0.5) speed = { mps: opts.beltSpeedMps, source: 'belt' };
  } else if (view === 'SAGITTAL' && kin.n > 10) {
    // Overground past a fixed camera: the hips cross the frame at running speed.
    const hx = new Float64Array(kin.n);
    for (let f = 0; f < kin.n; f++) hx[f] = kin.detected[f] ? hipX(kin, f) : NaN;
    const v = Math.abs(slope(kin.t, hx, 0, kin.n - 1));
    const travel = v * (kin.t[kin.n - 1] - kin.t[0]);
    const mps = (v * kin.cmPerPx) / 100;
    if (travel > kin.legPx && mps > 1.2 && mps < 9) speed = { mps, source: 'estimated' };
  }

  // ---- cadence: alternating-foot step times, or same-foot stride/2 as a fallback ----
  const stepT: number[] = [];
  for (let i = 1; i < contacts.length; i++) {
    const a = contacts[i - 1], b = contacts[i];
    const dt = kin.t[b.ic] - kin.t[a.ic];
    if (a.side !== b.side && dt > 0.2 && dt < 0.6) stepT.push(dt);
  }
  if (stepT.length < 2) {
    stepT.length = 0;
    for (const s of ['L', 'R'] as Side[]) {
      const cs = contacts.filter((c) => c.side === s);
      for (let i = 1; i < cs.length; i++) {
        const dt = kin.t[cs[i].ic] - kin.t[cs[i - 1].ic];
        if (dt > 0.4 && dt < 1.2) stepT.push(dt / 2);
      }
    }
  }
  const cadenceSpm = stepT.length ? 60 / medianOf(stepT) : NaN;

  const cm = (px: number) => px * kin.cmPerPx;
  const steps: StepMetrics[] = [];
  for (let i = 0; i < contacts.length; i++) {
    const c = contacts[i];
    const S = LEG[c.side], O = LEG[other(c.side)];
    const v: Record<string, number> = {};
    const { ic, ms, to, heelLift } = c;
    const ms_ = (kin.t[to] - kin.t[ic]) * 1000;
    v.gct = ms_;

    const next = contacts[i + 1];
    if (next && next.side !== c.side) {
      const fl = (kin.t[next.ic] - kin.t[to]) * 1000;
      if (fl > -40 && fl < 300) v.flight = fl;
      const stepS = kin.t[next.ic] - kin.t[ic];
      if (stepS > 0.2 && stepS < 0.6) {
        v.duty = (ms_ / 1000 / (2 * stepS)) * 100;
        let lo = Infinity, hi = -Infinity;
        for (let f = ic; f <= next.ic; f++) { const y = hipY(kin, f); lo = Math.min(lo, y); hi = Math.max(hi, y); }
        v.vertOsc = cm(hi - lo);
      }
    }

    if (view === 'SAGITTAL') {
      // Landing: the lower of heel / ball of foot at initial contact, relative to the hips.
      const heelLow = kin.y[S.heel][ic] >= kin.y[S.toe][ic];
      const landX = heelLow ? kin.x[S.heel][ic] : kin.x[S.toe][ic];
      v.landing = cm(fwd(kin, landX - hipX(kin, ic)));
      // Shank angle: positive when the ankle is AHEAD of the knee (reaching forward).
      v.shank = Math.atan2(fwd(kin, kin.x[S.ankle][ic] - kin.x[S.knee][ic]), kin.y[S.ankle][ic] - kin.y[S.knee][ic]) * DEG;
      const footAng = (f: number) => Math.atan2(-(kin.y[S.toe][f] - kin.y[S.heel][f]), fwd(kin, kin.x[S.toe][f] - kin.x[S.heel][f])) * DEG;
      v.strike = footAng(ic) - footAng(ms);
      v.kneeIC = kneeFlex(kin, c.side, ic);
      let pk = -Infinity;
      for (let f = ic; f <= to; f++) pk = Math.max(pk, kneeFlex(kin, c.side, f));
      v.kneeStancePeak = pk;
      v.trunk = leanFromVertical(kin, hipX(kin, ms), hipY(kin, ms), shoulderX(kin, ms), shoulderY(kin, ms));
      v.fall = leanFromVertical(kin, kin.x[S.toe][heelLift], kin.y[S.toe][heelLift], hipX(kin, heelLift), hipY(kin, heelLift));
      v.toeOff = leanFromVertical(kin, kin.x[S.toe][to], kin.y[S.toe][to], hipX(kin, to), hipY(kin, to));
      // The Pose: at midstance the swing ankle should be under the hips, rising toward the support knee.
      v.poseSwing = cm(fwd(kin, hipX(kin, ms) - kin.x[O.ankle][ms]));
      const kneeH = kin.y[S.ankle][ms] - kin.y[S.knee][ms];
      v.poseHeight = kneeH > 0 ? ((kin.y[S.ankle][ms] - kin.y[O.ankle][ms]) / kneeH) * 100 : NaN;
      // Pull: peak knee flexion during the following swing of this leg.
      const nextSame = contacts.slice(i + 1).find((x) => x.side === c.side);
      if (nextSame && kin.t[nextSame.ic] - kin.t[to] < 1.0) {
        let sk = -Infinity;
        for (let f = to; f <= nextSame.ic; f++) sk = Math.max(sk, kneeFlex(kin, c.side, f));
        v.swingKnee = sk;
      }
    } else {
      const midX = (f: number) => hipX(kin, f);
      // Crossover: landing ankle relative to the pelvis midline, positive = crossing toward/over it.
      const outward = Math.sign(kin.x[S.hip][ic] - kin.x[O.hip][ic]) || 1;
      v.crossover = cm(-(kin.x[S.ankle][ic] - midX(ic)) * outward);
      // Contralateral pelvic drop at midstance (positive = swing-side hip lower).
      const hw = Math.abs(kin.x[S.hip][ms] - kin.x[O.hip][ms]);
      if (hw > 0) v.pelvicDrop = Math.atan2(kin.y[O.hip][ms] - kin.y[S.hip][ms], hw) * DEG;
      if (next && next.side !== c.side) v.stepWidth = cm(Math.abs(kin.x[S.ankle][ic] - kin.x[O.ankle][next.ic]));
      // Knee collapse: peak frontal-plane knee angle through the loading half of stance.
      let kv = -Infinity;
      const end = Math.round(ic + 0.6 * (to - ic));
      for (let f = ic; f <= end; f++) kv = Math.max(kv, kneeFrontal(kin, c.side, f));
      v.kneeValgus = kv;
    }
    steps.push({ side: c.side, contact: c, values: v });
  }

  // ---- summaries ----
  const keys = new Set(steps.flatMap((s) => Object.keys(s.values)));
  const summary: Record<string, MetricSummary> = {};
  for (const key of keys) {
    const L = steps.filter((s) => s.side === 'L').map((s) => s.values[key]);
    const R = steps.filter((s) => s.side === 'R').map((s) => s.values[key]);
    const sL = stat(L), sR = stat(R), all = stat([...L, ...R]);
    let scored = all, scoredFrom: ScoredFrom = 'both';
    if (view === 'SAGITTAL' && !BOTH_LEGS.has(key)) {
      const swing = SWING_LEG.has(key);
      const supportSide = swing ? other(nearSide) : nearSide;
      const s = supportSide === 'L' ? sL : sR;
      if (s.n >= MIN_NEAR) { scored = s; scoredFrom = swing ? 'swing-near' : 'near'; }
    }
    summary[key] = { L: sL, R: sR, all, scored, scoredFrom, diff: sL.mean - sR.mean };
  }
  const whole = (s: Stat): MetricSummary => ({ L: EMPTY, R: EMPTY, all: s, scored: s, scoredFrom: 'both', diff: NaN });
  summary.cadence = whole({ mean: cadenceSpm, sd: NaN, n: stepT.length });
  if (speed && Number.isFinite(cadenceSpm)) {
    // Step length from speed and cadence.
    summary.stepLength = whole({ mean: (speed.mps * 100 * 60) / cadenceSpm, sd: NaN, n: stepT.length });
  }

  if (view === 'SAGITTAL') {
    const e: number[] = [];
    for (let f = 0; f < kin.n; f += 2) if (kin.detected[f]) e.push(180 - jointAngle(kin, LEG[nearSide].shoulder, LEG[nearSide].elbow, LEG[nearSide].wrist, f));
    summary.elbow = whole(stat(e));
  } else {
    // Side-to-side trunk sway: spread of the shoulders-over-hips angle.
    const lean: number[] = [];
    const cross: number[] = [];
    for (let f = 0; f < kin.n; f++) {
      if (!kin.detected[f]) continue;
      lean.push(Math.atan2(shoulderX(kin, f) - hipX(kin, f), hipY(kin, f) - shoulderY(kin, f)) * DEG);
      // Arm crossing: how far each wrist goes past the body midline (positive = across).
      const mid = shoulderX(kin, f);
      for (const s of ['L', 'R'] as Side[]) {
        const S = LEG[s], O = LEG[other(s)];
        const inward = Math.sign(kin.x[O.shoulder][f] - kin.x[S.shoulder][f]) || 1;
        cross.push((kin.x[S.wrist][f] - mid) * inward);
      }
    }
    if (lean.length > 10) summary.trunkSway = whole({ mean: percentile(lean, 0.95) - percentile(lean, 0.05), sd: NaN, n: lean.length });
    if (cross.length > 10) summary.armCross = whole({ mean: cm(percentile(cross, 0.95)), sd: NaN, n: cross.length });
  }

  if (contacts.length < 4) warnings.push(`Only ${contacts.length} foot contacts were detected. Film at least 10 seconds of steady running with the whole body in frame.`);
  if (kin.swappedFrames > kin.n * 0.05) warnings.push('The tracker mixed up left and right legs in many frames; side-specific numbers may be unreliable.');
  return { view, kin, contacts, contactsEdited, steps, summary, cadenceSpm, footVisibility, nearSide, scale, speed, warnings };
}
