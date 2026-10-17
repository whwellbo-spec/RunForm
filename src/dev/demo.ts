// Development-only demo data: a synthetic side-view runner.
import { allocPoseTrack, LM, offset } from '../analysis/landmarks';

export function synthRunner(opts: { cadence: number; duty: number; landingPx: number; seconds?: number; fps?: number; noise?: number; swapAt?: number[] }) {
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
