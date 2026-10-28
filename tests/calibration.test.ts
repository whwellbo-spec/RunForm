import { describe, expect, it } from 'vitest';
import { LM, offset } from '../src/analysis/landmarks';
import { analyzeGait } from '../src/analysis/metrics';
import { confidenceOf, poseReport, rangesFor, METRICS } from '../src/analysis/posemethod';
import { synthRunner } from '../src/dev/demo';

const H = 183.3; // synthetic runner: leg 900 px ≈ 90 cm → ~0.1 cm/px from height

/** Belt speed (m/s) that the synthetic runner's planted foot actually moves at, for a given cm/px. */
function beltFor(cadence: number, duty: number, cmPerPx: number) {
  const stride = 120 / cadence;
  const pxPerS = 600 / (duty * stride);
  return (pxPerS * cmPerPx) / 100;
}

describe('treadmill belt calibration', () => {
  it('uses the belt speed to set distances when it agrees with the video', () => {
    const track = synthRunner({ cadence: 170, duty: 0.34, landingPx: 200 });
    const belt = beltFor(170, 0.34, 0.11); // 10% larger scale than height suggests
    const g = analyzeGait(track, 'SAGITTAL', { heightCm: H, treadmill: true, beltSpeedMps: belt });
    expect(g.scale.source).toBe('belt');
    expect(g.scale.cmPerPx).toBeGreaterThan(0.105);
    expect(g.scale.cmPerPx).toBeLessThan(0.115);
    expect(g.speed?.mps).toBeCloseTo(belt, 5);
    expect(g.summary.stepLength.scored.mean).toBeGreaterThan(0);
  });

  it('falls back to height and warns when the belt speed is way off', () => {
    const track = synthRunner({ cadence: 170, duty: 0.34, landingPx: 200 });
    const g = analyzeGait(track, 'SAGITTAL', { heightCm: H, treadmill: true, beltSpeedMps: beltFor(170, 0.34, 0.1) * 2 });
    expect(g.scale.source).toBe('height');
    expect(g.warnings.some((w) => w.includes('belt speed'))).toBe(true);
    expect(g.scale.impliedBeltMps).toBeCloseTo(beltFor(170, 0.34, g.scale.heightCmPerPx), 1);
  });

  it('estimates overground speed when the runner crosses the frame', () => {
    const track = synthRunner({ cadence: 170, duty: 0.34, landingPx: 200 });
    // Move the whole body forward at 4000 px/s (≈ 4 m/s at 0.1 cm/px).
    for (let f = 0; f < track.nFrames; f++) for (let lm = 0; lm < 33; lm++) {
      const o = offset(f, lm, 0);
      if (Number.isFinite(track.px[o])) track.px[o] += 4000 * track.realTimeS[f];
    }
    const g = analyzeGait(track, 'SAGITTAL', { heightCm: H, treadmill: false });
    expect(g.speed?.source).toBe('estimated');
    expect(g.speed!.mps).toBeGreaterThan(3.5);
    expect(g.speed!.mps).toBeLessThan(4.5);
  });
});

describe('near-leg scoring in side view', () => {
  it('scores leg metrics from the leg nearer the camera', () => {
    const track = synthRunner({ cadence: 172, duty: 0.34, landingPx: 150 });
    for (let f = 0; f < track.nFrames; f++) for (const lm of [LM.R_HEEL, LM.R_FOOT_INDEX, LM.R_ANKLE]) track.px[offset(f, lm, 3)] = 0.4;
    const g = analyzeGait(track, 'SAGITTAL', { heightCm: H });
    expect(g.nearSide).toBe('L');
    expect(g.summary.landing.scoredFrom).toBe('near');
    expect(g.summary.landing.scored.n).toBe(g.summary.landing.L.n);
    expect(g.summary.poseSwing.scoredFrom).toBe('swing-near');
    expect(g.summary.poseSwing.scored.n).toBe(g.summary.poseSwing.R.n);
    expect(g.summary.trunk.scoredFrom).toBe('both');
  });
});

describe('manual contact corrections', () => {
  it('replaces detected contacts and recomputes', () => {
    const track = synthRunner({ cadence: 170, duty: 0.34, landingPx: 200 });
    const auto = analyzeGait(track, 'SAGITTAL', { heightCm: H });
    const edits = auto.contacts.slice(2).map((c) => ({ side: c.side, ic: c.ic, to: c.to }));
    const g = analyzeGait(track, 'SAGITTAL', { heightCm: H, contacts: edits });
    expect(g.contactsEdited).toBe(true);
    expect(g.contacts.length).toBe(auto.contacts.length - 2);
    expect(g.contacts[0].ms).toBeGreaterThanOrEqual(g.contacts[0].ic);
  });
});

describe('ranges, confidence and general advice', () => {
  const cad = METRICS.find((m) => m.id === 'cadence' && m.view === 'SAGITTAL')!;
  const gct = METRICS.find((m) => m.id === 'gct' && m.view === 'SAGITTAL')!;
  it('moves cadence up and contact time down with speed', () => {
    expect(rangesFor(cad, 4.5).good[0]).toBeGreaterThan(rangesFor(cad, 2.5).good[0]);
    expect(rangesFor(gct, 4.5).good[1]).toBeLessThan(rangesFor(gct, 2.5).good[1]);
    expect(rangesFor(cad, null).speedAdjusted).toBe(false);
  });
  it('rates few or scattered strides as low confidence', () => {
    expect(confidenceOf(2, 1, [0, 10])).toBe('low');
    expect(confidenceOf(8, 2, [0, 10])).toBe('high');
    expect(confidenceOf(8, 20, [0, 10])).toBe('low');
    expect(confidenceOf(4, 4, [0, 10])).toBe('medium');
  });
  it('adds general findings for an overstrider without replacing the Pose report', () => {
    const rep = poseReport(analyzeGait(synthRunner({ cadence: 158, duty: 0.4, landingPx: 320 }), 'SAGITTAL', { heightCm: H }));
    expect(rep.issues[0]).toBeDefined();
    expect(rep.general.some((f) => f.id === 'cadence')).toBe(true);
    expect(rep.reliability.strides).toBeGreaterThan(5);
  });
});
