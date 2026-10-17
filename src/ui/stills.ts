// Annotated key-frame images (landing, the Pose, the fall), rendered from the
// source video and stored as small JPEGs with the session.
import { medianOf } from '../analysis/filter';
import type { Contact } from '../analysis/gait';
import type { PoseTrack } from '../analysis/landmarks';
import type { GaitResult, StepMetrics } from '../analysis/metrics';
import { disposeVideo, loadVideo, seekTo } from '../media/seek';
import { annotate, bodyBox, drawSkeleton, type StillKind } from './draw';

export type Stills = Partial<Record<StillKind, string>>;

/** The most typical stance on the camera-side leg (landing closest to the median). */
export function representativeStep(g: GaitResult): StepMetrics | undefined {
  const near = g.steps.filter((s) => s.side === g.nearSide);
  const pool = near.length >= 2 ? near : g.steps;
  if (!pool.length) return undefined;
  const key = g.view === 'SAGITTAL' ? 'landing' : 'gct';
  const med = medianOf(pool.map((s) => s.values[key]));
  return [...pool].sort((a, b) => Math.abs(a.values[key] - med) - Math.abs(b.values[key] - med))[0];
}

export function stillFrame(c: Contact, kind: StillKind) {
  return kind === 'landing' ? c.ic : kind === 'pose' ? c.ms : c.heelLift;
}

export async function renderStills(file: File, track: PoseTrack, g: GaitResult, outH = 720): Promise<Stills> {
  const step = representativeStep(g);
  if (!step) return {};
  const kinds: StillKind[] = g.view === 'SAGITTAL' ? ['landing', 'pose', 'fall'] : ['landing', 'pose'];
  const v = await loadVideo(file);
  const out: Stills = {};
  try {
    for (const kind of kinds) {
      const f = stillFrame(step.contact, kind);
      const t = track.mediaTimeS[f];
      const next = track.mediaTimeS[Math.min(track.nFrames - 1, f + 1)];
      await seekTo(v, t + Math.max(0, (next - t) * 0.25));
      // Crop to the runner with a margin, 3:4 portrait.
      const b = bodyBox(g.kin, f);
      const bh = (b.y1 - b.y0) * 1.3, bw = (b.x1 - b.x0) * 1.4;
      let ch = Math.max(bh, (bw * 4) / 3), cw = (ch * 3) / 4;
      ch = Math.min(ch, track.height); cw = Math.min(cw, track.width);
      const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
      const ox = Math.max(0, Math.min(track.width - cw, cx - cw / 2));
      const oy = Math.max(0, Math.min(track.height - ch, cy - ch / 2));
      const s = outH / ch;
      const cv = document.createElement('canvas');
      cv.width = Math.round(cw * s); cv.height = outH;
      const ctx = cv.getContext('2d')!;
      // Video intrinsic size may differ from track size (e.g. seek path) — scale accordingly.
      const kx = v.videoWidth / track.width, ky = v.videoHeight / track.height;
      ctx.drawImage(v, ox * kx, oy * ky, cw * kx, ch * ky, 0, 0, cv.width, cv.height);
      ctx.fillStyle = 'rgba(8,13,24,.18)';
      ctx.fillRect(0, 0, cv.width, cv.height);
      const view = { s, ox, oy };
      drawSkeleton(ctx, g.kin, f, view, Math.max(2.5, cv.width / 150));
      annotate(ctx, g.kin, step.contact, kind, view, step.values);
      out[kind] = cv.toDataURL('image/jpeg', 0.8);
    }
  } finally {
    disposeVideo(v);
  }
  return out;
}
