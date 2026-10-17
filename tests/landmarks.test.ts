import { describe, expect, it } from 'vitest';
import { hashDiff, isDuplicate, rgbaToGray } from '../src/analysis/framehash';
import { allocPoseTrack, Field, LM, meanVisibility, NUM_LANDMARKS, offset, STRIDE, writeFrame } from '../src/analysis/landmarks';

describe('pose track layout', () => {
  it('stores frame × landmark × field in typed arrays, normalized and pixel', () => {
    const t = allocPoseTrack(3, 1920, 1080);
    expect(t.norm).toBeInstanceOf(Float32Array);
    expect(t.norm.length).toBe(3 * NUM_LANDMARKS * 4);
    const lms = Array.from({ length: 33 }, (_, i) => ({ x: i / 100, y: 0.5, z: -0.1, visibility: 0.9 }));
    writeFrame(t, 1, lms, lms);
    expect(t.detected[1]).toBe(1);
    expect(t.detected[0]).toBe(0);
    expect(t.norm[offset(1, LM.L_HEEL, Field.X)]).toBeCloseTo(0.29, 6);
    expect(t.px[offset(1, LM.L_HEEL, Field.X)]).toBeCloseTo(0.29 * 1920, 3);
    expect(t.px[offset(1, LM.L_HEEL, Field.Y)]).toBeCloseTo(540, 3);
    expect(t.px[offset(1, LM.L_HEEL, Field.Z)]).toBeCloseTo(-192, 3);
    expect(t.px[1 * STRIDE + LM.L_HEEL * 4 + 3]).toBeCloseTo(0.9, 6);
    expect(Number.isNaN(t.norm[offset(0, 0, Field.X)])).toBe(true);
    expect(meanVisibility(t, LM.R_HEEL)).toBeCloseTo(0.9, 6);
  });

  it('marks frames with no pose as undetected', () => {
    const t = allocPoseTrack(1, 10, 10);
    writeFrame(t, 0, undefined, undefined);
    expect(t.detected[0]).toBe(0);
  });
});

describe('frame hash', () => {
  const img = (f: (i: number) => number) => {
    const rgba = new Uint8ClampedArray(64 * 36 * 4);
    for (let i = 0; i < 64 * 36; i++) { const v = f(i); rgba.set([v, v, v, 255], i * 4); }
    return rgbaToGray(rgba);
  };
  it('detects exact and near-exact duplicates', () => {
    const a = img((i) => (i * 7) % 256);
    const b = img((i) => Math.min(255, ((i * 7) % 256) + (i % 2)));
    expect(isDuplicate(hashDiff(a, a))).toBe(true);
    expect(isDuplicate(hashDiff(a, b))).toBe(true);
  });
  it('keeps distinct frames where only a small region moves', () => {
    // Static background, a "runner" patch of 6 pixels changes by 40 levels.
    const a = img(() => 100);
    const b = img((i) => (i >= 1000 && i < 1006 ? 140 : 100));
    const d = hashDiff(a, b);
    expect(d.mean).toBeLessThan(0.2); // a mean-based test would call this a duplicate
    expect(isDuplicate(d)).toBe(false);
  });
});
