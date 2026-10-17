// Signal conditioning for landmark trajectories. Pure, no DOM.

/**
 * Fill NaN runs by linear interpolation. Leading/trailing NaNs take the
 * nearest valid value. Returns the number of filled samples; runs longer than
 * maxGap are filled too but counted in `longGaps`.
 */
export function fillGaps(x: Float64Array, maxGap = Infinity): { filled: number; longGaps: number } {
  const n = x.length;
  let filled = 0, longGaps = 0;
  let last = -1;
  for (let i = 0; i <= n; i++) {
    if (i < n && Number.isNaN(x[i])) continue;
    const gap = i - last - 1;
    if (gap > 0) {
      filled += gap;
      if (gap > maxGap) longGaps++;
      if (last < 0 && i < n) for (let k = 0; k < i; k++) x[k] = x[i];
      else if (i >= n && last >= 0) for (let k = last + 1; k < n; k++) x[k] = x[last];
      else if (last >= 0 && i < n) {
        const a = x[last], b = x[i];
        for (let k = last + 1; k < i; k++) x[k] = a + ((b - a) * (k - last)) / (i - last);
      }
    }
    last = i;
  }
  return { filled, longGaps };
}

interface Biquad { b0: number; b1: number; b2: number; a1: number; a2: number }

/** 2nd-order low-pass Butterworth via the bilinear transform. */
export function butterLowpass(fc: number, fs: number): Biquad {
  const fcc = Math.min(fc, fs * 0.45);
  const k = Math.tan((Math.PI * fcc) / fs);
  const q = Math.SQRT2;
  const norm = 1 / (1 + q * k + k * k);
  const b0 = k * k * norm;
  return { b0, b1: 2 * b0, b2: b0, a1: 2 * (k * k - 1) * norm, a2: (1 - q * k + k * k) * norm };
}

function biquadRun(c: Biquad, x: Float64Array): Float64Array {
  const y = new Float64Array(x.length);
  // Initialise state to the first sample's steady state to avoid a start-up transient.
  let x1 = x[0], x2 = x[0], y1 = x[0], y2 = x[0];
  for (let i = 0; i < x.length; i++) {
    const v = c.b0 * x[i] + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v;
    y[i] = v;
  }
  return y;
}

/**
 * Zero-phase low-pass (forward + backward 2nd-order Butterworth = 4th-order
 * response). The cutoff is corrected for the double pass (Winter 2009,
 * Biomechanics and Motor Control of Human Movement, §3.4: C = 0.802), so
 * `fc` is the true −3 dB point. Input must be NaN-free.
 */
export function filtfilt(x: Float64Array, fc: number, fs: number): Float64Array {
  const n = x.length;
  if (n < 4 || !(fc > 0) || !(fs > 0)) return Float64Array.from(x);
  const c = butterLowpass(fc / 0.802, fs);
  // Reflect-pad to reduce edge transients.
  const pad = Math.min(n - 1, Math.max(3, Math.round((3 * fs) / fc)));
  const ext = new Float64Array(n + 2 * pad);
  for (let i = 0; i < pad; i++) {
    ext[i] = 2 * x[0] - x[pad - i];
    ext[n + pad + i] = 2 * x[n - 1] - x[n - 2 - i];
  }
  ext.set(x, pad);
  const f = biquadRun(c, ext);
  f.reverse();
  const b = biquadRun(c, f);
  b.reverse();
  return b.slice(pad, pad + n);
}

/** Central-difference derivative (units per second). */
export function derivative(x: Float64Array, fs: number): Float64Array {
  const n = x.length;
  const d = new Float64Array(n);
  if (n < 2) return d;
  d[0] = (x[1] - x[0]) * fs;
  d[n - 1] = (x[n - 1] - x[n - 2]) * fs;
  for (let i = 1; i < n - 1; i++) d[i] = ((x[i + 1] - x[i - 1]) * fs) / 2;
  return d;
}

export function percentile(values: ArrayLike<number>, p: number): number {
  const v = Array.from(values).filter((a) => Number.isFinite(a)).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const i = Math.min(v.length - 1, Math.max(0, (v.length - 1) * p));
  const lo = Math.floor(i), hi = Math.ceil(i);
  return v[lo] + (v[hi] - v[lo]) * (i - lo);
}

/** Sliding-window maximum (window = 2*half+1), O(n·w) — fine for our sizes. */
export function rollingMax(x: Float64Array, half: number): Float64Array {
  const n = x.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let m = -Infinity;
    for (let k = Math.max(0, i - half); k <= Math.min(n - 1, i + half); k++) if (x[k] > m) m = x[k];
    out[i] = m;
  }
  return out;
}

export function mean(v: number[]): number {
  const f = v.filter(Number.isFinite);
  return f.length ? f.reduce((a, b) => a + b, 0) / f.length : NaN;
}

export function sd(v: number[]): number {
  const f = v.filter(Number.isFinite);
  if (f.length < 2) return NaN;
  const m = mean(f);
  return Math.sqrt(f.reduce((a, b) => a + (b - m) ** 2, 0) / (f.length - 1));
}

export function medianOf(v: number[]): number {
  const f = v.filter(Number.isFinite).sort((a, b) => a - b);
  if (!f.length) return NaN;
  const m = f.length >> 1;
  return f.length % 2 ? f[m] : (f[m - 1] + f[m]) / 2;
}
