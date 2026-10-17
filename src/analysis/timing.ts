// Frame timing analysis: interval histograms, frame-rate detection, slow-mo
// defaults and media-time -> real-time conversion. Pure, no DOM.

export interface IntervalStats {
  count: number; // number of intervals (frames - 1)
  medianS: number;
  meanS: number;
  minS: number;
  maxS: number;
  /** Frame rate implied by the median interval (media timeline). */
  fps: number;
  /** Fraction of intervals within ±tolerance of the median. */
  uniformFraction: number;
  /** Coefficient of variation of the intervals. */
  cv: number;
}

export interface HistogramBin {
  /** Mean interval of the bin's members, in milliseconds of media time. */
  ms: number;
  count: number;
}

/** Frame-to-frame intervals from presentation timestamps (seconds, sorted). */
export function intervals(timesS: ArrayLike<number>, start = 0, end = timesS.length - 1): Float64Array {
  const n = Math.max(0, end - start);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = timesS[start + i + 1] - timesS[start + i];
  return out;
}

export function median(values: ArrayLike<number>): number {
  if (values.length === 0) return NaN;
  const s = Float64Array.from(values).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function intervalStats(iv: ArrayLike<number>, tolerance = 0.05): IntervalStats {
  const n = iv.length;
  if (n === 0) {
    return { count: 0, medianS: NaN, meanS: NaN, minS: NaN, maxS: NaN, fps: NaN, uniformFraction: NaN, cv: NaN };
  }
  const med = median(iv);
  let sum = 0, min = Infinity, max = -Infinity, within = 0;
  for (let i = 0; i < n; i++) {
    const v = iv[i];
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
    if (Math.abs(v - med) <= tolerance * med) within++;
  }
  const mean = sum / n;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (iv[i] - mean) ** 2;
  const sd = Math.sqrt(ss / n);
  return { count: n, medianS: med, meanS: mean, minS: min, maxS: max, fps: 1 / med, uniformFraction: within / n, cv: sd / mean };
}

/**
 * Histogram of intervals in ms. Bins are `binMs` wide and aligned to multiples
 * of binMs; each bin reports the mean of its members so a uniform 4.167 ms
 * clip reads as 4.167, not the bin edge. Only non-empty bins, sorted by ms.
 */
export function intervalHistogram(iv: ArrayLike<number>, binMs = 0.5): HistogramBin[] {
  const map = new Map<number, { sum: number; count: number }>();
  for (let i = 0; i < iv.length; i++) {
    const ms = iv[i] * 1000;
    const k = Math.round(ms / binMs);
    const b = map.get(k) ?? { sum: 0, count: 0 };
    b.sum += ms;
    b.count++;
    map.set(k, b);
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => ({ ms: b.sum / b.count, count: b.count }));
}

const COMMON_FPS = [24, 25, 30, 48, 50, 60, 100, 120, 240];

/** Snap a measured fps to a common camera rate if within 3%. */
export function snapFps(fps: number): number {
  for (const c of COMMON_FPS) if (Math.abs(fps - c) / c < 0.03) return c;
  return Math.round(fps * 100) / 100;
}

export type TimingKind = 'native-high-fps' | 'retimed-slowmo' | 'normal';

export interface TimingSettings {
  /** Real-world capture rate of the camera (frames per real second). */
  captureFps: number;
  /**
   * How much the file's timeline is stretched relative to real time:
   * realSeconds = mediaSeconds / slowmoFactor. 1 = file timestamps are real time.
   */
  slowmoFactor: number;
}

export interface TimingGuess extends TimingSettings {
  kind: TimingKind;
  reason: string;
}

/**
 * Guess capture fps / slow-mo factor from what the file actually contains.
 *
 * - Median interval < 1/90 s: the file stores high-rate samples on a real-time
 *   timeline (iPhone original slow-mo .MOV from the Files app). Timestamps are
 *   already real time, so the factor is 1 and capture fps is the measured rate.
 * - ~30 fps container with slow-mo hints (Apple slow-mo metadata found in the
 *   moov box): assume an export retimed to 30 fps playback, default 240 fps / 8x.
 * - Otherwise: a normal-speed clip.
 */
export function guessTiming(containerFps: number, slowmoHint: boolean): TimingGuess {
  if (containerFps >= 90) {
    const fps = snapFps(containerFps);
    return {
      kind: 'native-high-fps',
      captureFps: fps,
      slowmoFactor: 1,
      reason: `Samples are ${fps} fps on the file timeline, so timestamps are already real time.`,
    };
  }
  if (slowmoHint) {
    return {
      kind: 'retimed-slowmo',
      captureFps: 240,
      slowmoFactor: 8,
      reason: `Slow-mo metadata found with a ~${snapFps(containerFps)} fps timeline: assuming retimed 240 fps / 8x. Verify!`,
    };
  }
  const fps = snapFps(containerFps);
  return { kind: 'normal', captureFps: fps, slowmoFactor: 1, reason: `Looks like a normal ${fps} fps clip.` };
}

/**
 * Real-time timestamps (s) for a window of presentation times, relative to the
 * first frame of the window: (t - t0) / slowmoFactor.
 */
export function toRealTime(mediaTimesS: ArrayLike<number>, start: number, end: number, slowmoFactor: number): Float64Array {
  const n = end - start + 1;
  const out = new Float64Array(Math.max(0, n));
  const t0 = mediaTimesS[start];
  for (let i = 0; i < n; i++) out[i] = (mediaTimesS[start + i] - t0) / slowmoFactor;
  return out;
}

export interface TimingCheck {
  /** Media-timeline fps of the window (from its median interval). */
  windowMediaFps: number;
  /** Capture fps implied by the window and the slow-mo factor. */
  impliedCaptureFps: number;
  /** Relative mismatch between implied and entered capture fps. */
  mismatch: number;
  ok: boolean;
  /** Real-time duration of the window (s). */
  realDurationS: number;
  /** Media-timeline duration of the window (s). */
  mediaDurationS: number;
}

/** Sanity check: does the entered capture fps agree with the window's timing? */
export function checkTiming(mediaTimesS: ArrayLike<number>, start: number, end: number, s: TimingSettings): TimingCheck {
  const st = intervalStats(intervals(mediaTimesS, start, end));
  const implied = st.fps * s.slowmoFactor;
  const mismatch = Math.abs(implied - s.captureFps) / s.captureFps;
  const mediaDur = mediaTimesS[end] - mediaTimesS[start];
  return {
    windowMediaFps: st.fps,
    impliedCaptureFps: implied,
    mismatch,
    ok: mismatch < 0.02,
    mediaDurationS: mediaDur,
    realDurationS: mediaDur / s.slowmoFactor,
  };
}

/**
 * Longest run of consecutive intervals within ±tolerance of the reference
 * interval (default: the median of all intervals). Returns frame indices
 * [start, end] spanning that run, e.g. the constant-rate slow section between
 * speed ramps.
 */
export function longestUniformRun(timesS: ArrayLike<number>, tolerance = 0.05, refS?: number): { start: number; end: number } {
  const iv = intervals(timesS);
  if (iv.length === 0) return { start: 0, end: Math.max(0, timesS.length - 1) };
  const ref = refS ?? median(iv);
  let best = { start: 0, end: 0 }, runStart = -1;
  for (let i = 0; i <= iv.length; i++) {
    const ok = i < iv.length && Math.abs(iv[i] - ref) <= tolerance * ref;
    if (ok && runStart < 0) runStart = i;
    if (!ok && runStart >= 0) {
      // Intervals runStart..i-1 cover frames runStart..i.
      if (i - runStart > best.end - best.start) best = { start: runStart, end: i };
      runStart = -1;
    }
  }
  return best;
}
