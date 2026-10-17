// Canvas drawing for skeleton overlays and annotated key frames.
import { hipX, hipY, LEG, other, type Contact, type Kinematics } from '../analysis/gait';
import { CONNECTIONS, LM } from '../analysis/landmarks';

export const INK = { L: '#5EC8F2', R: '#F5A04A', mid: '#E8EDF5', guide: 'rgba(255,255,255,.9)', track: '#F0684C', good: '#49B98A' };

/** Maps track pixel coordinates to canvas coordinates. */
export interface View2D { s: number; ox: number; oy: number }
const X = (v: View2D, x: number) => (x - v.ox) * v.s;
const Y = (v: View2D, y: number) => (y - v.oy) * v.s;

export function drawSkeleton(ctx: CanvasRenderingContext2D, k: Kinematics, f: number, v: View2D, lw = 3) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const [a, b] of CONNECTIONS) {
    if (a === 0 || b === 0) continue;
    const left = a % 2 === 1 && b % 2 === 1;
    const right = a % 2 === 0 && b % 2 === 0;
    ctx.strokeStyle = left ? INK.L : right ? INK.R : INK.mid;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(X(v, k.x[a][f]), Y(v, k.y[a][f]));
    ctx.lineTo(X(v, k.x[b][f]), Y(v, k.y[b][f]));
    ctx.stroke();
  }
  // Head: a dot at the nose/ear centre.
  const hx = (k.x[LM.L_EAR][f] + k.x[LM.R_EAR][f]) / 2, hy = (k.y[LM.L_EAR][f] + k.y[LM.R_EAR][f]) / 2;
  ctx.fillStyle = INK.mid;
  ctx.beginPath(); ctx.arc(X(v, hx), Y(v, hy), lw * 2.2, 0, Math.PI * 2); ctx.fill();
  for (const lm of [LM.L_HIP, LM.R_HIP, LM.L_KNEE, LM.R_KNEE, LM.L_ANKLE, LM.R_ANKLE]) {
    ctx.fillStyle = lm % 2 ? INK.L : INK.R;
    ctx.beginPath(); ctx.arc(X(v, k.x[lm][f]), Y(v, k.y[lm][f]), lw * 1.3, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

function dashed(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, color: string, lw: number) {
  ctx.save();
  ctx.setLineDash([lw * 3, lw * 2.2]);
  ctx.strokeStyle = color; ctx.lineWidth = lw;
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  ctx.restore();
}

function solid(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, color: string, lw: number) {
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  ctx.restore();
}

export function pill(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, bg = 'rgba(8,13,24,.82)', fg = '#fff') {
  ctx.save();
  ctx.font = `700 ${size}px "Avenir Next Condensed", "Avenir Next", system-ui, sans-serif`;
  const w = ctx.measureText(text).width + size * 0.9, h = size * 1.5;
  const cw = ctx.canvas.width;
  const left = Math.max(4, Math.min(cw - w - 4, x - w / 2));
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(left, y - h / 2, w, h, h / 2);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, left + size * 0.45, y + 1);
  ctx.restore();
}

export type StillKind = 'landing' | 'pose' | 'fall';

/** Body bounding box (track px) at frame f. */
export function bodyBox(k: Kinematics, f: number) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let lm = 0; lm < 33; lm++) {
    const x = k.x[lm][f], y = k.y[lm][f];
    if (!Number.isFinite(x)) continue;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  return { x0, y0, x1, y1 };
}

/** Draw the annotation for a key moment on top of the skeleton. */
export function annotate(ctx: CanvasRenderingContext2D, k: Kinematics, c: Contact, kind: StillKind, v: View2D, values: Record<string, number>) {
  const S = LEG[c.side], O = LEG[other(c.side)];
  const lw = Math.max(2, ctx.canvas.width / 220);
  const fs = Math.max(14, ctx.canvas.width / 17);
  if (kind === 'landing') {
    const f = c.ic;
    const hx = X(v, hipX(k, f)), hy = Y(v, hipY(k, f));
    const heelLow = k.y[S.heel][f] >= k.y[S.toe][f];
    const lx = X(v, heelLow ? k.x[S.heel][f] : k.x[S.toe][f]);
    const gy = Y(v, Math.max(k.y[S.heel][f], k.y[S.toe][f]));
    dashed(ctx, hx, hy, hx, gy + lw * 4, INK.guide, lw);
    solid(ctx, hx, gy + lw * 3, lx, gy + lw * 3, INK.track, lw * 1.6);
    ctx.fillStyle = INK.track;
    ctx.beginPath(); ctx.arc(lx, gy, lw * 2.4, 0, Math.PI * 2); ctx.fill();
    const d = values.landing;
    if (Number.isFinite(d)) pill(ctx, `${Math.abs(Math.round(d))} cm ${d >= 0 ? 'ahead of' : 'behind'} hips`, (hx + lx) / 2, gy + lw * 3 + fs * 1.3, fs);
  } else if (kind === 'pose') {
    const f = c.ms;
    const hx = X(v, hipX(k, f));
    const sy = Y(v, Math.max(k.y[S.heel][f], k.y[S.toe][f]));
    dashed(ctx, hx, Y(v, (k.y[LM.L_SHOULDER][f] + k.y[LM.R_SHOULDER][f]) / 2) - fs, hx, sy + lw * 3, INK.guide, lw);
    const ax = X(v, k.x[O.ankle][f]), ay = Y(v, k.y[O.ankle][f]);
    ctx.strokeStyle = INK.track; ctx.lineWidth = lw * 1.4;
    ctx.beginPath(); ctx.arc(ax, ay, lw * 5, 0, Math.PI * 2); ctx.stroke();
    solid(ctx, hx, ay, ax, ay, INK.track, lw * 1.4);
    const d = values.poseSwing;
    if (Number.isFinite(d)) pill(ctx, `Swing foot ${Math.abs(Math.round(d))} cm ${d >= 0 ? 'behind' : 'ahead of'} hips`, hx, Math.min(ctx.canvas.height - fs, sy + fs * 1.6), fs);
  } else {
    const f = c.heelLift;
    const tx = X(v, k.x[S.toe][f]), ty = Y(v, k.y[S.toe][f]);
    const hx = X(v, hipX(k, f)), hy = Y(v, hipY(k, f));
    dashed(ctx, tx, ty, tx, hy - fs, INK.guide, lw);
    solid(ctx, tx, ty, hx, hy, INK.track, lw * 1.8);
    const a = values.fall;
    const r = Math.hypot(hx - tx, hy - ty) * 0.35;
    const start = -Math.PI / 2, dirSign = Math.sign(hx - tx) || 1;
    ctx.save();
    ctx.strokeStyle = INK.track; ctx.lineWidth = lw * 1.2;
    ctx.beginPath();
    const end = Math.atan2(hy - ty, hx - tx);
    ctx.arc(tx, ty, r, dirSign > 0 ? start : end, dirSign > 0 ? end : start);
    ctx.stroke();
    ctx.restore();
    if (Number.isFinite(a)) pill(ctx, `Fall ${Math.round(a)}°`, tx + dirSign * fs * 2.2, ty - r - fs * 0.4, fs);
  }
}
