import { describe, expect, it } from 'vitest';
import {
  checkTiming, guessTiming, intervalHistogram, intervals, intervalStats, longestUniformRun, snapFps, toRealTime,
} from '../src/analysis/timing';

const uniform = (n: number, fps: number, t0 = 0) => Float64Array.from({ length: n }, (_, i) => t0 + i / fps);

/** Retimed slow-mo: 30 fps ramp-in, 8x stretched section, ramp-out with growing intervals. */
function retimedClip() {
  const t: number[] = [0];
  const push = (dt: number) => t.push(t[t.length - 1] + dt);
  for (let i = 0; i < 30; i++) push(1 / 30 - i * 0.0004); // ramp in (variable)
  for (let i = 0; i < 600; i++) push(1 / 30); // slow section: uniform on the 30 fps timeline
  for (let i = 0; i < 30; i++) push(1 / 30 + i * 0.0004); // ramp out
  return Float64Array.from(t);
}

describe('interval statistics', () => {
  it('measures a native 240 fps clip', () => {
    const st = intervalStats(intervals(uniform(2400, 240)));
    expect(st.count).toBe(2399);
    expect(st.fps).toBeCloseTo(240, 6);
    expect(st.uniformFraction).toBe(1);
    expect(st.cv).toBeLessThan(1e-9);
  });

  it('histograms intervals into ms bins', () => {
    const h = intervalHistogram(intervals(uniform(100, 240)), 0.25);
    expect(h).toHaveLength(1);
    expect(h[0].ms).toBeCloseTo(1000 / 240, 6);
    expect(h[0].count).toBe(99);
  });

  it('shows ramps as extra histogram bins', () => {
    const h = intervalHistogram(intervals(retimedClip()), 0.25);
    expect(h.length).toBeGreaterThan(3);
    const main = h.reduce((a, b) => (b.count > a.count ? b : a));
    expect(main.ms).toBeCloseTo(1000 / 30, 6);
  });
});

describe('timing guesses', () => {
  it('treats native high-fps files as real-time timelines', () => {
    const g = guessTiming(239.8, false);
    expect(g.kind).toBe('native-high-fps');
    expect(g.captureFps).toBe(240);
    expect(g.slowmoFactor).toBe(1);
  });
  it('defaults to 240 fps / 8x for a 30 fps file with slow-mo metadata', () => {
    const g = guessTiming(30, true);
    expect(g).toMatchObject({ kind: 'retimed-slowmo', captureFps: 240, slowmoFactor: 8 });
  });
  it('treats a plain 30 fps file as normal speed', () => {
    expect(guessTiming(29.97, false)).toMatchObject({ kind: 'normal', captureFps: 30, slowmoFactor: 1 });
  });
  it('snaps to common rates', () => {
    expect(snapFps(119.88)).toBe(120);
    expect(snapFps(59.94)).toBe(60);
    expect(snapFps(77)).toBe(77);
  });
});

describe('real-time conversion', () => {
  it('divides file time by the slow-mo factor, relative to window start', () => {
    const t = uniform(301, 30, 5); // retimed: 30 fps on file
    const real = toRealTime(t, 0, 240, 8);
    expect(real[0]).toBe(0);
    expect(real[240]).toBeCloseTo(1, 9); // 240 frames at 240 fps = 1 s real
    expect(real[1]).toBeCloseTo(1 / 240, 9);
  });

  it('flags a factor that disagrees with the entered capture rate', () => {
    const t = uniform(301, 30);
    expect(checkTiming(t, 0, 300, { captureFps: 240, slowmoFactor: 8 }).ok).toBe(true);
    const bad = checkTiming(t, 0, 300, { captureFps: 240, slowmoFactor: 4 });
    expect(bad.ok).toBe(false);
    expect(bad.impliedCaptureFps).toBeCloseTo(120, 6);
    expect(bad.realDurationS).toBeCloseTo(10 / 4, 9);
  });
});

describe('longest uniform run', () => {
  it('finds the constant section between ramps', () => {
    const t = retimedClip();
    const r = longestUniformRun(t, 0.01);
    // Ramp-in intervals 0..29 (first two within 1% of 1/30), slow section intervals 30..629.
    expect(r.start).toBeLessThanOrEqual(31);
    expect(r.start).toBeGreaterThanOrEqual(29);
    expect(r.end).toBeGreaterThanOrEqual(630);
    expect(r.end).toBeLessThanOrEqual(634);
    const st = intervalStats(intervals(t, r.start, r.end), 0.01);
    expect(st.uniformFraction).toBe(1);
  });
});
