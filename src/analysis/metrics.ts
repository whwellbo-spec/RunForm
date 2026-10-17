// Per-step running metrics from kinematics + foot contacts. Pure, no DOM.
import { mean, medianOf, sd } from './filter';
import {
  buildKinematics, DEG, detectContacts, fwd, hipX, hipY, jointAngle, kneeFlex, LEG, leanFromVertical, other,
  shoulderX, shoulderY, type Contact, type Kinematics, type KinematicsOptions, type Side,
} from './gait';
import type { PoseTrack } from './landmarks';

export type View = 'SAGITTAL' | 'FRONTAL';

export interface StepMetrics {
  side: Side;
  contact: Contact;
  values: Record<string, number>;
}

export interface Stat { mean: number; sd: number; n: number }
export interface MetricSummary { L: Stat; R: Stat; all: Stat; diff: number }

export interface GaitResult {
  view: View;
  kin: Kinematics;
  contacts: Contact[];
  steps: StepMetrics[];
  summary: Record<string, MetricSummary>;
  cadenceSpm: number;
  /** Visibility of each leg's foot landmarks; in side view the far leg is lower. */
  footVisibility: Record<Side, number>;
  nearSide: Side;
  warnings: string[];
}

const stat = (v: number[]): Stat => ({ mean: mean(v), sd: sd(v), n: v.filter(Number.isFinite).length });

function footVis(k: Kinematics, s: Side): number {
  const L = LEG[s];
  let v = 0, c = 0;
  for (let f = 0; f < k.n; f++) if (k.detected[f]) { v += (k.vis[L.heel][f] + k.vis[L.toe][f] + k.vis[L.ankle][f]) / 3; c++; }
  return c ? v / c : 0;
}

export function analyzeGait(track: PoseTrack, view: View, opts: Partial<KinematicsOptions> = {}): GaitResult {
  const kin = buildKinematics(track, opts);
  const warnings: string[] = [];
  if (kin.detectedFraction < 0.8) warnings.push(`A runner was found in only ${Math.round(kin.detectedFraction * 100)}% of frames.`);

  const requireBackward = view === 'SAGITTAL';
  const contacts = [...detectContacts(kin, 'L', { requireBackward }), ...detectContacts(kin, 'R', { requireBackward })]
    .sort((a, b) => a.ic - b.ic);
  if (view === 'FRONTAL') for (const c of contacts) { c.ms = Math.round((c.ic + c.to) / 2); }

  // Cadence: alternating-foot step times, or same-foot stride/2 as a fallback.
  const stepT: number[] = [];
  for (let i = 1; i < contacts.length; i++) {
    const a = contacts[i - 1], b = contacts[i];
    const dt = kin.t[b.ic] - kin.t[a.ic];
    if (a.side !== b.side && dt > 0.2 && dt < 0.6) stepT.push(dt);
  }
  if (stepT.length < 2) {
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
      const swEnd = nextSame ? nextSame.ic : Math.min(kin.n - 1, to + Math.round(0.5 * kin.fs));
      if (nextSame || swEnd < kin.n - 1) {
        let sk = -Infinity;
        for (let f = to; f <= swEnd; f++) sk = Math.max(sk, kneeFlex(kin, c.side, f));
        if (nextSame && kin.t[nextSame.ic] - kin.t[to] < 1.0) v.swingKnee = sk;
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
    }
    steps.push({ side: c.side, contact: c, values: v });
  }

  const keys = new Set(steps.flatMap((s) => Object.keys(s.values)));
  const summary: Record<string, MetricSummary> = {};
  for (const key of keys) {
    const L = steps.filter((s) => s.side === 'L').map((s) => s.values[key]);
    const R = steps.filter((s) => s.side === 'R').map((s) => s.values[key]);
    const sL = stat(L), sR = stat(R);
    summary[key] = { L: sL, R: sR, all: stat([...L, ...R]), diff: sL.mean - sR.mean };
  }
  summary.cadence = { L: stat([]), R: stat([]), all: { mean: cadenceSpm, sd: NaN, n: stepT.length }, diff: NaN };

  if (view === 'SAGITTAL') {
    const near: Side = footVis(kin, 'L') >= footVis(kin, 'R') ? 'L' : 'R';
    const e: number[] = [];
    for (let f = 0; f < kin.n; f += 2) if (kin.detected[f]) e.push(180 - jointAngle(kin, LEG[near].shoulder, LEG[near].elbow, LEG[near].wrist, f));
    summary.elbow = { L: stat([]), R: stat([]), all: stat(e), diff: NaN };
  }

  const footVisibility = { L: footVis(kin, 'L'), R: footVis(kin, 'R') };
  const nearSide: Side = footVisibility.L >= footVisibility.R ? 'L' : 'R';
  if (contacts.length < 4) warnings.push(`Only ${contacts.length} foot contacts were detected. Film at least 10 seconds of steady running with the whole body in frame.`);
  if (kin.swappedFrames > kin.n * 0.05) warnings.push('The tracker mixed up left and right legs in many frames; side-specific numbers may be unreliable.');
  return { view, kin, contacts, steps, summary, cadenceSpm, footVisibility, nearSide, warnings };
}
