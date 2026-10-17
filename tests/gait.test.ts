import { describe, expect, it } from 'vitest';
import { filtfilt, fillGaps } from '../src/analysis/filter';
import { analyzeGait } from '../src/analysis/metrics';
import { allocPoseTrack, LM, offset } from '../src/analysis/landmarks';
import { poseReport, scoreValue } from '../src/analysis/posemethod';

/**
 * Synthetic side-view treadmill runner facing +x. Leg length 900 px for a
 * 183 cm runner (0.491·H ≈ 90 cm → 1 px ≈ 1 mm).
 */
function synthRunner(opts: { cadence: number; duty: number; landingPx: number; seconds?: number; fps?: number; noise?: number; swapAt?: number[] }) {
  const fps = opts.fps ?? 240, seconds = opts.seconds ?? 6;
  const n = Math.round(fps * seconds);
  const W = 3000, H = 2400;
  const t = allocPoseTrack(n, W, H);
  const stride = 120 / opts.cadence; // s
  const hipX0 = 1500, ground = 2200, thigh = 450, shank = 450;
  const stanceLen = 600; // px the foot travels backward during stance
  const rnd = (() => { let s = 1; return () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 2; })();
  const nz = () => (opts.noise ?? 0) * rnd();
  for (let f = 0; f < n; f++) {
    const time = f / fps;
    t.realTimeS[f] = time; t.mediaTimeS[f] = time; t.frameIndex[f] = f; t.detected[f] = 1;
    const hipY = ground - 830 + 30 * Math.cos((4 * Math.PI * time) / stride);
    const set = (lm: number, x: number, y: number) => {
      t.px[offset(f, lm, 0)] = x + nz(); t.px[offset(f, lm, 1)] = y + nz(); t.px[offset(f, lm, 3)] = 0.95;
    };
    for (const [side, ph0] of [['L', 0], ['R', 0.5]] as const) {
      const ph = (((time / stride + ph0) % 1) + 1) % 1;
      let ax: number, ay: number;
      if (ph < opts.duty) { // stance: foot on the belt moving backward
        ax = hipX0 + opts.landingPx - stanceLen * (ph / opts.duty);
        ay = ground - 60;
      } else { // swing: lift and bring forward
        const s = (ph - opts.duty) / (1 - opts.duty);
        ax = hipX0 + opts.landingPx - stanceLen + (stanceLen) * (0.5 - 0.5 * Math.cos(Math.PI * s));
        ay = ground - 60 - 380 * Math.sin(Math.PI * s);
      }
      // 2-link IK for the knee (knee forward).
      const dx = ax - hipX0, dy = ay - hipY, d = Math.min(thigh + shank - 1, Math.hypot(dx, dy));
      const a = Math.atan2(dy, dx), b = Math.acos((thigh * thigh + d * d - shank * shank) / (2 * thigh * d));
      const kx = hipX0 + thigh * Math.cos(a - b), ky = hipY + thigh * Math.sin(a - b);
      const L = side === 'L';
      set(L ? LM.L_HIP : LM.R_HIP, hipX0, hipY);
      set(L ? LM.L_KNEE : LM.R_KNEE, kx, ky);
      set(L ? LM.L_ANKLE : LM.R_ANKLE, ax, ay);
      set(L ? LM.L_HEEL : LM.R_HEEL, ax - 60, ay + 60);
      set(L ? LM.L_FOOT_INDEX : LM.R_FOOT_INDEX, ax + 140, ay + 60);
      set(L ? LM.L_SHOULDER : LM.R_SHOULDER, hipX0 + 60, hipY - 520);
      set(L ? LM.L_ELBOW : LM.R_ELBOW, hipX0 + 20, hipY - 250);
      set(L ? LM.L_WRIST : LM.R_WRIST, hipX0 + 200, hipY - 250);
    }
    if (opts.swapAt?.includes(f)) {
      for (const [l, r] of [[LM.L_KNEE, LM.R_KNEE], [LM.L_ANKLE, LM.R_ANKLE], [LM.L_HEEL, LM.R_HEEL], [LM.L_FOOT_INDEX, LM.R_FOOT_INDEX]]) {
        for (const fld of [0, 1]) { const a = t.px[offset(f, l, fld)]; t.px[offset(f, l, fld)] = t.px[offset(f, r, fld)]; t.px[offset(f, r, fld)] = a; }
      }
    }
  }
  return t;
}

describe('filter', () => {
  it('fills gaps linearly and holds the ends', () => {
    const x = Float64Array.from([NaN, 1, NaN, NaN, 4, NaN]);
    fillGaps(x);
    expect(Array.from(x)).toEqual([1, 1, 2, 3, 4, 4]);
  });
  it('passes low frequencies and removes high ones with zero phase', () => {
    const fs = 240, n = 960;
    const lo = new Float64Array(n), mixed = new Float64Array(n);
    for (let i = 0; i < n; i++) { lo[i] = Math.sin(2 * Math.PI * 2 * i / fs); mixed[i] = lo[i] + 0.5 * Math.sin(2 * Math.PI * 60 * i / fs); }
    const y = filtfilt(mixed, 8, fs);
    let err = 0;
    for (let i = 100; i < n - 100; i++) err = Math.max(err, Math.abs(y[i] - lo[i]));
    expect(err).toBeLessThan(0.03);
  });
  it('has about −3 dB at the cutoff after the double pass', () => {
    const fs = 240, n = 2400, fc = 10;
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.sin(2 * Math.PI * fc * i / fs);
    const y = filtfilt(x, fc, fs);
    let amp = 0;
    for (let i = 400; i < n - 400; i++) amp = Math.max(amp, Math.abs(y[i]));
    expect(amp).toBeGreaterThan(0.65);
    expect(amp).toBeLessThan(0.76);
  });
});

describe('gait analysis on a synthetic runner', () => {
  it('recovers cadence, contact time and landing distance', () => {
    const track = synthRunner({ cadence: 170, duty: 0.34, landingPx: 250 });
    const g = analyzeGait(track, 'SAGITTAL', { heightCm: 183.3 });
    expect(g.kin.dir).toBe(1);
    expect(g.kin.cmPerPx).toBeGreaterThan(0.08);
    expect(g.kin.cmPerPx).toBeLessThan(0.12);
    expect(g.contacts.length).toBeGreaterThan(12);
    expect(g.cadenceSpm).toBeGreaterThan(165);
    expect(g.cadenceSpm).toBeLessThan(175);
    const stride = 120 / 170;
    expect(g.summary.gct.all.mean).toBeGreaterThan(0.34 * stride * 1000 - 30);
    expect(g.summary.gct.all.mean).toBeLessThan(0.34 * stride * 1000 + 30);
    // Lower point at IC is the heel/toe (same height), ankle lands 250 px ahead → ~19–39 cm.
    expect(g.summary.landing.all.mean).toBeGreaterThan(15);
    expect(g.summary.landing.all.mean).toBeLessThan(40);
    const rep = poseReport(g);
    expect(rep.issues.some((i) => i.def.id === 'landing')).toBe(true);
    expect(Number.isFinite(rep.overall)).toBe(true);
  });

  it('scores a runner landing under the hips better than an overstrider', () => {
    const good = poseReport(analyzeGait(synthRunner({ cadence: 180, duty: 0.32, landingPx: 40 }), 'SAGITTAL', { heightCm: 183.3 }));
    const bad = poseReport(analyzeGait(synthRunner({ cadence: 160, duty: 0.4, landingPx: 320 }), 'SAGITTAL', { heightCm: 183.3 }));
    const sc = (r: typeof good, id: string) => r.metrics.find((m) => m.def.id === id)!.score;
    for (const id of ['landing', 'cadence', 'gct']) expect(sc(good, id)).toBeGreaterThan(sc(bad, id));
    expect(bad.issues.map((i) => i.def.id)).toEqual(expect.arrayContaining(['landing', 'gct', 'cadence']));
  });

  it('survives noise and brief left/right swaps', () => {
    const track = synthRunner({ cadence: 175, duty: 0.33, landingPx: 120, noise: 4, swapAt: [300, 301, 302, 700, 701] });
    const g = analyzeGait(track, 'SAGITTAL', { heightCm: 183.3 });
    expect(g.kin.swappedFrames).toBeGreaterThan(0);
    expect(g.cadenceSpm).toBeGreaterThan(168);
    expect(g.cadenceSpm).toBeLessThan(182);
  });
});

describe('scoring', () => {
  it('is 100 in range and falls off outside', () => {
    const d = { good: [0, 10] as [number, number], ok: [-5, 20] as [number, number] };
    expect(scoreValue(5, d)).toBe(100);
    expect(scoreValue(20, d)).toBeCloseTo(60);
    expect(scoreValue(15, d)).toBeCloseTo(80);
    expect(scoreValue(30, d)).toBeCloseTo(0);
    expect(scoreValue(-5, d)).toBeCloseTo(60);
  });
});
