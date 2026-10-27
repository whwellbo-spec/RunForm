import { describe, expect, it } from 'vitest';
import { checkSlowmo, estimateRhythm, retime, suggestFactor } from '../src/analysis/slowmo';
import { synthRunner } from '../src/dev/demo';
import type { PoseTrack } from '../src/analysis/landmarks';

/** Re-stamp a synthetic track as if its frames sat on a slower file timeline. */
function asFile(t: PoseTrack, fileFps: number, analyzedFactor: number): PoseTrack {
  for (let f = 0; f < t.nFrames; f++) {
    t.mediaTimeS[f] = f / fileFps;
    t.realTimeS[f] = f / fileFps / analyzedFactor;
  }
  return t;
}

describe('slow-mo rhythm check', () => {
  it('finds the stride period of a normal 30 fps clip', () => {
    const t = synthRunner({ cadence: 170, duty: 0.35, landingPx: 200, fps: 30, seconds: 8, noise: 3 });
    const r = estimateRhythm(t)!;
    expect(r.strideMediaS).toBeCloseTo(120 / 170, 1);
    expect(checkSlowmo(t, 1)!.suggestedFactor).toBeNull();
  });

  it('flags 240 fps slo-mo that iOS retimed to 30 fps (8x) when read as normal speed', () => {
    // 1920 frames captured at 240 fps = 8 s real; on a 30 fps file that is 64 s.
    const t = asFile(synthRunner({ cadence: 168, duty: 0.35, landingPx: 200, fps: 240, seconds: 8, noise: 3 }), 30, 1);
    const c = checkSlowmo(t, 1)!;
    expect(c.cadenceSpm).toBeLessThan(30);
    expect(c.suggestedFactor).toBe(8);
    expect(c.suggestedCadenceSpm).toBeGreaterThan(160);
    expect(c.suggestedCadenceSpm).toBeLessThan(176);
  });

  it('still works on a short window (240 frames of 8x slo-mo, about 1.5 strides)', () => {
    const t = asFile(synthRunner({ cadence: 175, duty: 0.35, landingPx: 200, fps: 240, seconds: 1.6, noise: 2 }), 30, 1);
    expect(checkSlowmo(t, 1)?.suggestedFactor).toBe(8);
  });

  it('flags 120 fps slo-mo retimed 4x', () => {
    const t = asFile(synthRunner({ cadence: 180, duty: 0.33, landingPx: 150, fps: 120, seconds: 6, noise: 3 }), 30, 1);
    expect(checkSlowmo(t, 1)!.suggestedFactor).toBe(4);
  });

  it('flags a normal clip wrongly treated as 8x slo-mo', () => {
    const t = asFile(synthRunner({ cadence: 165, duty: 0.36, landingPx: 200, fps: 30, seconds: 10, noise: 3 }), 30, 8);
    expect(checkSlowmo(t, 8)!.suggestedFactor).toBe(1);
  });

  it('accepts a correctly labeled slo-mo clip', () => {
    const t = asFile(synthRunner({ cadence: 172, duty: 0.35, landingPx: 200, fps: 240, seconds: 6, noise: 3 }), 30, 8);
    expect(checkSlowmo(t, 8)!.suggestedFactor).toBeNull();
  });

  it('survives missed detections', () => {
    const t = asFile(synthRunner({ cadence: 170, duty: 0.35, landingPx: 200, fps: 240, seconds: 6, noise: 3 }), 30, 1);
    for (let f = 0; f < t.nFrames; f++) if (f % 7 === 0 || (f > 400 && f < 430)) t.detected[f] = 0;
    expect(checkSlowmo(t, 1)!.suggestedFactor).toBe(8);
  });

  it('retime rewrites real time from the file timeline', () => {
    const t = asFile(synthRunner({ cadence: 170, duty: 0.35, landingPx: 200, fps: 240, seconds: 2 }), 30, 1);
    retime(t, 8);
    expect(t.realTimeS[240]).toBeCloseTo(1, 6);
  });

  it('suggestFactor returns null for impossible rhythms', () => {
    expect(suggestFactor(20)).toBeNull();
  });
});
