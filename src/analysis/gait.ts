// Turns a raw PoseTrack into smoothed kinematics and detects foot contacts.
// Pure, no DOM. Image coordinates: x right, y DOWN (pixels).
import { fillGaps, filtfilt, medianOf, percentile, rollingMax } from './filter';
import { LM, offset, type PoseTrack } from './landmarks';

export type Side = 'L' | 'R';

export interface LegIdx { hip: number; knee: number; ankle: number; heel: number; toe: number; shoulder: number; elbow: number; wrist: number }
export const LEG: Record<Side, LegIdx> = {
  L: { hip: LM.L_HIP, knee: LM.L_KNEE, ankle: LM.L_ANKLE, heel: LM.L_HEEL, toe: LM.L_FOOT_INDEX, shoulder: LM.L_SHOULDER, elbow: LM.L_ELBOW, wrist: LM.L_WRIST },
  R: { hip: LM.R_HIP, knee: LM.R_KNEE, ankle: LM.R_ANKLE, heel: LM.R_HEEL, toe: LM.R_FOOT_INDEX, shoulder: LM.R_SHOULDER, elbow: LM.R_ELBOW, wrist: LM.R_WRIST },
};
export const other = (s: Side): Side => (s === 'L' ? 'R' : 'L');

export interface KinematicsOptions {
  /** Low-pass cutoff for angles and segment kinematics (Hz). */
  angleCutoffHz: number;
  /** Higher cutoff for foot signals used in event detection (Hz). */
  eventCutoffHz: number;
  /** Runner standing height (cm) used for pixel→cm scaling. */
  heightCm: number;
}

export const DEFAULT_KIN_OPTIONS: KinematicsOptions = { angleCutoffHz: 8, eventCutoffHz: 16, heightCm: 175 };

export interface Kinematics {
  n: number;
  fs: number;
  t: Float64Array;
  /** Smoothed (angle cutoff) pixel coords per landmark. */
  x: Float64Array[];
  y: Float64Array[];
  /** Lightly smoothed (event cutoff) coords. */
  xe: Float64Array[];
  ye: Float64Array[];
  vis: Float64Array[];
  detected: Uint8Array;
  /** +1 if the runner faces +x in the image, −1 if −x. */
  dir: 1 | -1;
  /** Hip-to-ankle length in pixels (thigh + shank, 90th percentile). */
  legPx: number;
  cmPerPx: number;
  swappedFrames: number;
  detectedFraction: number;
  filledFraction: number;
}

// Winter (2009), Table 4.1: thigh 0.245·H, leg (shank) 0.246·H.
const LEG_FRACTION_OF_HEIGHT = 0.245 + 0.246;

const LEG_PAIRS: Array<[number, number]> = [
  [LM.L_HIP, LM.R_HIP], [LM.L_KNEE, LM.R_KNEE], [LM.L_ANKLE, LM.R_ANKLE],
  [LM.L_HEEL, LM.R_HEEL], [LM.L_FOOT_INDEX, LM.R_FOOT_INDEX],
];
const SWAP_TEST = [LM.L_KNEE, LM.L_ANKLE, LM.L_HEEL, LM.L_FOOT_INDEX];
const SWAP_TEST_R = [LM.R_KNEE, LM.R_ANKLE, LM.R_HEEL, LM.R_FOOT_INDEX];

/**
 * BlazePose occasionally swaps left/right legs for a few frames in side view.
 * At high frame rates a real limb moves only a little between frames, so if
 * the swapped assignment is much closer to the previous frame than the
 * labelled one, swap the leg landmarks back. Operates in place on raw arrays.
 */
export function fixLegSwaps(x: Float64Array[], y: Float64Array[], vis: Float64Array[], n: number): number {
  let swapped = 0;
  let prev = -1;
  const d = (a: number, fa: number, b: number, fb: number) => Math.hypot(x[a][fa] - x[b][fb], y[a][fa] - y[b][fb]);
  for (let f = 0; f < n; f++) {
    if (Number.isNaN(x[LM.L_ANKLE][f]) || Number.isNaN(x[LM.R_ANKLE][f])) continue;
    if (prev >= 0 && f - prev <= 6) {
      let same = 0, swap = 0;
      for (let k = 0; k < SWAP_TEST.length; k++) {
        const l = SWAP_TEST[k], r = SWAP_TEST_R[k];
        same += d(l, f, l, prev) + d(r, f, r, prev);
        swap += d(l, f, r, prev) + d(r, f, l, prev);
      }
      if (swap < 0.5 * same) {
        for (const [l, r] of LEG_PAIRS) {
          for (const arr of [x, y, vis]) { const t = arr[l][f]; arr[l][f] = arr[r][f]; arr[r][f] = t; }
        }
        swapped++;
      }
    }
    prev = f;
  }
  return swapped;
}

export function buildKinematics(track: PoseTrack, opts: Partial<KinematicsOptions> = {}): Kinematics {
  const o = { ...DEFAULT_KIN_OPTIONS, ...opts };
  const n = track.nFrames;
  const rx: Float64Array[] = [], ry: Float64Array[] = [], vis: Float64Array[] = [];
  let det = 0;
  for (let f = 0; f < n; f++) det += track.detected[f];
  for (let lm = 0; lm < 33; lm++) {
    const ax = new Float64Array(n).fill(NaN), ay = new Float64Array(n).fill(NaN), av = new Float64Array(n);
    for (let f = 0; f < n; f++) {
      if (!track.detected[f]) continue;
      ax[f] = track.px[offset(f, lm, 0)];
      ay[f] = track.px[offset(f, lm, 1)];
      av[f] = track.px[offset(f, lm, 3)];
    }
    rx.push(ax); ry.push(ay); vis.push(av);
  }
  const swappedFrames = fixLegSwaps(rx, ry, vis, n);

  let filled = 0;
  for (let lm = 0; lm < 33; lm++) { filled += fillGaps(rx[lm]).filled; fillGaps(ry[lm]); }

  const dts: number[] = [];
  for (let f = 1; f < n; f++) { const dt = track.realTimeS[f] - track.realTimeS[f - 1]; if (dt > 0) dts.push(dt); }
  const fs = dts.length ? 1 / medianOf(dts) : 30;

  const x = rx.map((a) => filtfilt(a, o.angleCutoffHz, fs));
  const y = ry.map((a) => filtfilt(a, o.angleCutoffHz, fs));
  const xe = rx.map((a) => filtfilt(a, o.eventCutoffHz, fs));
  const ye = ry.map((a) => filtfilt(a, o.eventCutoffHz, fs));

  // Facing direction from toe-ahead-of-heel.
  const diffs: number[] = [];
  for (let f = 0; f < n; f++) {
    if (!track.detected[f]) continue;
    diffs.push(x[LM.L_FOOT_INDEX][f] - x[LM.L_HEEL][f], x[LM.R_FOOT_INDEX][f] - x[LM.R_HEEL][f]);
  }
  const dir: 1 | -1 = (medianOf(diffs) || 1) >= 0 ? 1 : -1;

  // Leg length: thigh + shank at their most extended (90th pct, limits foreshortening).
  const seg = (a: number, b: number) => {
    const v: number[] = [];
    for (let f = 0; f < n; f++) if (track.detected[f]) v.push(Math.hypot(x[a][f] - x[b][f], y[a][f] - y[b][f]));
    return percentile(v, 0.9);
  };
  const legPx =
    (seg(LM.L_HIP, LM.L_KNEE) + seg(LM.L_KNEE, LM.L_ANKLE) + seg(LM.R_HIP, LM.R_KNEE) + seg(LM.R_KNEE, LM.R_ANKLE)) / 2;
  const cmPerPx = (o.heightCm * LEG_FRACTION_OF_HEIGHT) / legPx;

  return {
    n, fs, t: track.realTimeS, x, y, xe, ye, vis, detected: track.detected, dir, legPx, cmPerPx, swappedFrames,
    detectedFraction: n ? det / n : 0,
    filledFraction: n ? filled / (33 * n) : 0,
  };
}

// ---------- geometry helpers ----------
export const hipX = (k: Kinematics, f: number) => (k.x[LM.L_HIP][f] + k.x[LM.R_HIP][f]) / 2;
export const hipY = (k: Kinematics, f: number) => (k.y[LM.L_HIP][f] + k.y[LM.R_HIP][f]) / 2;
export const shoulderX = (k: Kinematics, f: number) => (k.x[LM.L_SHOULDER][f] + k.x[LM.R_SHOULDER][f]) / 2;
export const shoulderY = (k: Kinematics, f: number) => (k.y[LM.L_SHOULDER][f] + k.y[LM.R_SHOULDER][f]) / 2;
/** Forward-positive horizontal coordinate. */
export const fwd = (k: Kinematics, xv: number) => k.dir * xv;
export const DEG = 180 / Math.PI;

/** Interior angle at b (degrees) for points a-b-c. */
export function jointAngle(k: Kinematics, a: number, b: number, c: number, f: number): number {
  const ux = k.x[a][f] - k.x[b][f], uy = k.y[a][f] - k.y[b][f];
  const vx = k.x[c][f] - k.x[b][f], vy = k.y[c][f] - k.y[b][f];
  const cos = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy));
  return Math.acos(Math.max(-1, Math.min(1, cos))) * DEG;
}

/** Knee flexion (0 = straight). */
export const kneeFlex = (k: Kinematics, s: Side, f: number) => 180 - jointAngle(k, LEG[s].hip, LEG[s].knee, LEG[s].ankle, f);

/**
 * Angle from vertical of the line from a lower point to an upper point,
 * positive when the upper point is AHEAD (forward) of the lower one.
 */
export function leanFromVertical(k: Kinematics, lowX: number, lowY: number, upX: number, upY: number): number {
  return Math.atan2(fwd(k, upX - lowX), lowY - upY) * DEG;
}

// ---------- foot contacts ----------
export interface Contact {
  side: Side;
  ic: number; // initial contact frame
  ms: number; // midstance: support ankle passes under the hips
  heelLift: number; // heel starts to rise (end of the "fall", start of the "pull")
  to: number; // toe-off frame
  confidence: number; // 0..1 from landmark visibility
}

export interface EventOptions {
  /** Enter contact when the foot's lowest point is within this fraction of leg length of the ground. */
  enterFrac: number;
  /** Leave contact when it rises above this fraction. */
  exitFrac: number;
  minContactS: number;
  maxContactS: number;
  /** Side view: require the foot to move backward relative to the hips during stance. */
  requireBackward: boolean;
}
export const DEFAULT_EVENT_OPTIONS: EventOptions = { enterFrac: 0.035, exitFrac: 0.06, minContactS: 0.07, maxContactS: 0.6, requireBackward: true };

/**
 * Foot contact detection from foot height. For each foot, the lowest of
 * heel/toe (event-filtered) is compared with a local ground level (rolling
 * maximum of image y over ±0.45 s, which always spans a stance). Contact uses
 * hysteresis on height above ground, scaled by leg length. A candidate is kept
 * only if the foot moves backward relative to the hips during it (true of
 * every real stance, on a treadmill or overground).
 */
export function detectContacts(k: Kinematics, side: Side, eo: Partial<EventOptions> = {}): Contact[] {
  const o = { ...DEFAULT_EVENT_OPTIONS, ...eo };
  const L = LEG[side];
  const n = k.n;
  const low = new Float64Array(n);
  for (let f = 0; f < n; f++) low[f] = Math.max(k.ye[L.heel][f], k.ye[L.toe][f]);
  const ground = rollingMax(low, Math.max(2, Math.round(0.45 * k.fs)));
  const enter = o.enterFrac * k.legPx, exit = o.exitFrac * k.legPx;

  const raw: Array<[number, number]> = [];
  let inC = false, start = 0;
  for (let f = 0; f < n; f++) {
    const h = ground[f] - low[f];
    if (!inC && h < enter) { inC = true; start = f; }
    else if (inC && h > exit) { inC = false; raw.push([start, f - 1]); }
  }
  // Contacts touching the window edges are incomplete.
  const out: Contact[] = [];
  for (const [ic, to] of raw) {
    if (ic === 0 || to >= n - 1) continue;
    const dur = k.t[to] - k.t[ic];
    if (dur < o.minContactS || dur > o.maxContactS) continue;
    const relIc = fwd(k, k.x[L.ankle][ic] - hipX(k, ic));
    const relTo = fwd(k, k.x[L.ankle][to] - hipX(k, to));
    if (o.requireBackward && !(relTo < relIc - 0.1 * k.legPx)) continue;

    out.push(completeContact(k, side, ic, to));
  }
  return out;
}

/**
 * Fill in midstance, heel lift and confidence for a contact given its landing
 * (ic) and toe-off (to) frames. Used for detected and hand-corrected contacts.
 */
export function completeContact(k: Kinematics, side: Side, ic: number, to: number): Contact {
  const L = LEG[side];
  ic = Math.max(0, Math.min(k.n - 1, Math.round(ic)));
  to = Math.max(ic + 1, Math.min(k.n - 1, Math.round(to)));
  // Midstance: support ankle crosses under the hips.
  let ms = ic, best = Infinity;
  for (let f = ic; f <= to; f++) {
    const r = fwd(k, k.x[L.ankle][f] - hipX(k, f));
    if (Math.abs(r) < best) { best = Math.abs(r); ms = f; }
  }
  // Heel lift: heel rises clearly above its lowest stance position after midstance.
  let heelMax = -Infinity;
  for (let f = ic; f <= to; f++) heelMax = Math.max(heelMax, k.ye[L.heel][f]);
  let heelLift = -1;
  for (let f = ms; f <= to; f++) if (heelMax - k.ye[L.heel][f] > 0.025 * k.legPx) { heelLift = f; break; }
  if (heelLift < 0) heelLift = Math.round(ic + 0.65 * (to - ic));
  let v = 0, c = 0;
  for (let f = ic; f <= to; f++) { v += (k.vis[L.heel][f] + k.vis[L.toe][f] + k.vis[L.ankle][f]) / 3; c++; }
  return { side, ic, ms, heelLift, to, confidence: c ? v / c : 0 };
}

/** Least-squares slope of y against t. */
export function slope(t: ArrayLike<number>, y: ArrayLike<number>, from: number, to: number): number {
  let n = 0, st = 0, sy = 0, stt = 0, sty = 0;
  for (let i = from; i <= to; i++) {
    if (!Number.isFinite(y[i])) continue;
    n++; st += t[i]; sy += y[i]; stt += t[i] * t[i]; sty += t[i] * y[i];
  }
  const d = n * stt - st * st;
  return n >= 3 && d !== 0 ? (n * sty - st * sy) / d : NaN;
}

/**
 * Speed of the foot along the image x axis while it is planted (px/s,
 * forward-positive). On a treadmill a planted foot rides the belt, so this is
 * the belt speed in pixels; overground it is ~0. Uses the middle half of each
 * stance, away from touchdown and push-off.
 */
export function stanceFootSpeedsPx(k: Kinematics, contacts: Contact[]): number[] {
  const out: number[] = [];
  for (const c of contacts) {
    const L = LEG[c.side];
    const a = Math.round(c.ic + 0.25 * (c.to - c.ic)), b = Math.round(c.to - 0.25 * (c.to - c.ic));
    if (b - a < 3) continue;
    const foot = new Float64Array(k.n).fill(NaN);
    for (let f = a; f <= b; f++) foot[f] = (k.x[L.heel][f] + k.x[L.toe][f] + k.x[L.ankle][f]) / 3;
    const v = slope(k.t, foot, a, b);
    if (Number.isFinite(v)) out.push(k.dir * v);
  }
  return out;
}
