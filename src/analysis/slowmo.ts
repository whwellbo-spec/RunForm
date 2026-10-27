// Slow-mo sanity check from the runner's own rhythm. Pure, no DOM.
//
// iOS often hands a slo-mo clip to the web view as a rendered copy: a normal
// 30 fps file that plays 8x slower (or 4x for 120 fps slo-mo). Nothing in the
// container says so, so we look at the movement instead. The left-minus-right
// foot position repeats once per stride; its period on the file timeline tells
// us how much the clip is stretched, because real running cadence only lives
// in a narrow band (~140–215 steps/min).
import { LM, offset, type PoseTrack } from './landmarks';

export const SLOWMO_FACTORS = [1, 2, 4, 8] as const;
const CADENCE_MIN = 140;
const CADENCE_MAX = 215;
const CADENCE_TARGET = 170;

export interface RhythmEstimate {
  /** Stride period on the file (media) timeline, seconds. */
  strideMediaS: number;
  /** Autocorrelation strength of the stride peak (0..1). */
  strength: number;
}

export interface SlowmoCheck extends RhythmEstimate {
  /** Cadence implied by the current slow-mo factor (steps/min). */
  cadenceSpm: number;
  /** Factor that puts cadence in the human running band, if it differs from the current one. */
  suggestedFactor: number | null;
  /** Cadence implied by the suggested factor. */
  suggestedCadenceSpm: number;
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Linear-interpolate NaNs; leading/trailing NaNs take the nearest value. Returns false if too sparse. */
function interpolate(x: Float64Array): boolean {
  const n = x.length;
  let first = -1;
  for (let i = 0; i < n; i++) if (Number.isFinite(x[i])) { first = i; break; }
  if (first < 0) return false;
  for (let i = 0; i < first; i++) x[i] = x[first];
  let prev = first, valid = 1;
  for (let i = first + 1; i < n; i++) {
    if (!Number.isFinite(x[i])) continue;
    valid++;
    for (let j = prev + 1; j < i; j++) x[j] = x[prev] + ((x[i] - x[prev]) * (j - prev)) / (i - prev);
    prev = i;
  }
  for (let i = prev + 1; i < n; i++) x[i] = x[prev];
  return valid >= n * 0.5;
}

function detrend(x: Float64Array): void {
  const n = x.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += x[i]; sxx += i * i; sxy += i * x[i]; }
  const b = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1);
  const a = (sy - b * sx) / n;
  for (let i = 0; i < n; i++) x[i] -= a + b * i;
}

/** Normalized autocorrelation for lags [minLag, maxLag]; each lag divided by its overlap. */
function autocorr(x: Float64Array, minLag: number, maxLag: number): Float64Array {
  const n = x.length;
  let e = 0;
  for (let i = 0; i < n; i++) e += x[i] * x[i];
  const out = new Float64Array(maxLag + 1).fill(NaN);
  if (e === 0) return out;
  const e0 = e / n;
  for (let k = minLag; k <= maxLag; k++) {
    let s = 0;
    for (let i = 0; i + k < n; i++) s += x[i] * x[i + k];
    out[k] = s / (n - k) / e0;
  }
  return out;
}

/**
 * Estimate the stride period on the file timeline from the left/right foot
 * difference (x and y, so it works for side and front views).
 */
export function estimateRhythm(track: PoseTrack): RhythmEstimate | null {
  const n = track.nFrames;
  if (n < 40) return null;
  const iv: number[] = [];
  for (let i = 1; i < n; i++) iv.push(track.mediaTimeS[i] - track.mediaTimeS[i - 1]);
  const dt = median(iv);
  if (!(dt > 0)) return null;

  const signals: Float64Array[] = [];
  for (const field of [0, 1]) {
    const s = new Float64Array(n);
    for (let f = 0; f < n; f++) {
      if (!track.detected[f]) { s[f] = NaN; continue; }
      const l = (track.px[offset(f, LM.L_ANKLE, field)] + track.px[offset(f, LM.L_HEEL, field)]) / 2;
      const r = (track.px[offset(f, LM.R_ANKLE, field)] + track.px[offset(f, LM.R_HEEL, field)]) / 2;
      s[f] = l - r;
    }
    if (interpolate(s)) { detrend(s); signals.push(s); }
  }
  if (!signals.length) return null;

  // Media-timeline stride period spans a normal clip (fast runner, ~0.45 s)
  // up to a 240 fps clip slowed 8x (~7.5 s). Need some overlap at the max lag.
  const minLag = Math.max(2, Math.floor(0.4 / dt));
  const maxLag = Math.min(Math.floor(7.5 / dt), Math.floor(n * 0.75));
  if (maxLag <= minLag + 2) return null;

  const acs = signals.map((s) => autocorr(s, minLag, maxLag));
  const ac = new Float64Array(maxLag + 1).fill(NaN);
  for (let k = minLag; k <= maxLag; k++) {
    let sum = 0, c = 0;
    for (const a of acs) if (Number.isFinite(a[k])) { sum += a[k]; c++; }
    ac[k] = c ? sum / c : NaN;
  }

  // Local maxima above a floor; take the shortest lag close to the strongest
  // peak, so a multiple of the stride (2x, 3x lag) never wins.
  const peaks: number[] = [];
  for (let k = minLag + 1; k < maxLag; k++) {
    if (ac[k] > 0.3 && ac[k] > ac[k - 1] && ac[k] >= ac[k + 1]) peaks.push(k);
  }
  if (!peaks.length) return null;
  const best = Math.max(...peaks.map((k) => ac[k]));
  const k = peaks.find((p) => ac[p] >= 0.7 * best)!;
  // Parabolic refinement of the peak lag.
  const y0 = ac[k - 1], y1 = ac[k], y2 = ac[k + 1];
  const denom = y0 - 2 * y1 + y2;
  const delta = Number.isFinite(denom) && denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom)) : 0;
  return { strideMediaS: (k + delta) * dt, strength: y1 };
}

/** Cadence (steps/min) for a stride period on the file timeline and a slow-mo factor. */
export function cadenceFor(strideMediaS: number, factor: number): number {
  return (120 * factor) / strideMediaS;
}

/** Pick the slow-mo factor whose implied cadence is a plausible running cadence. */
export function suggestFactor(strideMediaS: number): number | null {
  let best: number | null = null, bestErr = Infinity;
  for (const f of SLOWMO_FACTORS) {
    const c = cadenceFor(strideMediaS, f);
    if (c < CADENCE_MIN || c > CADENCE_MAX) continue;
    const err = Math.abs(c - CADENCE_TARGET);
    if (err < bestErr) { best = f; bestErr = err; }
  }
  return best;
}

/** Compare the clip's rhythm with the slow-mo factor it was analyzed with. */
export function checkSlowmo(track: PoseTrack, currentFactor: number): SlowmoCheck | null {
  const r = estimateRhythm(track);
  if (!r) return null;
  const cadenceSpm = cadenceFor(r.strideMediaS, currentFactor);
  const inBand = cadenceSpm >= CADENCE_MIN && cadenceSpm <= CADENCE_MAX;
  const s = inBand ? null : suggestFactor(r.strideMediaS);
  return {
    ...r,
    cadenceSpm,
    suggestedFactor: s !== null && s !== currentFactor ? s : null,
    suggestedCadenceSpm: s !== null ? cadenceFor(r.strideMediaS, s) : NaN,
  };
}

/** Rewrite a track's real-time stamps for a new slow-mo factor (landmarks are unchanged). */
export function retime(track: PoseTrack, factor: number): void {
  const t0 = track.mediaTimeS[0];
  for (let i = 0; i < track.nFrames; i++) track.realTimeS[i] = (track.mediaTimeS[i] - t0) / factor;
}
