// Stride timeline: knee angle and hip height over the analysed window, with
// foot contacts shaded. Tap or drag to move the video to that moment.
import { hipY, kneeFlex, type Side } from '../analysis/gait';
import type { GaitResult } from '../analysis/metrics';
import { INK } from './draw';

const css = (name: string, fallback: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

export class StrideChart {
  readonly el: HTMLElement;
  onSeek?: (frame: number) => void;
  private cv: HTMLCanvasElement;
  private frame = 0;
  private knee: Record<Side, Float64Array> = { L: new Float64Array(0), R: new Float64Array(0) };
  private hip = new Float64Array(0);
  private hipRange: [number, number] = [-5, 5];
  private ro?: ResizeObserver;

  constructor(private g: GaitResult) {
    this.el = document.createElement('div');
    this.el.className = 'chart';
    this.el.innerHTML = `<canvas aria-label="Knee angle and hip height over time"></canvas>
      <p class="fine chart-legend">
        <span class="key" style="--c:${INK.L}"></span>Left knee
        <span class="key" style="--c:${INK.R}"></span>Right knee
        <span class="key key-line"></span>Hip height
        · shaded bars = foot on the ground · tap to jump the video there</p>`;
    this.cv = this.el.querySelector('canvas')!;
    const pick = (e: PointerEvent) => {
      const r = this.cv.getBoundingClientRect();
      const { left, w } = this.plotX(r.width);
      const u = Math.max(0, Math.min(1, (e.clientX - r.left - left) / w));
      const f = Math.round(u * (this.g.kin.n - 1));
      this.setFrame(f);
      this.onSeek?.(f);
    };
    this.cv.addEventListener('pointerdown', (e) => { this.cv.setPointerCapture(e.pointerId); pick(e); });
    this.cv.addEventListener('pointermove', (e) => { if (e.buttons) pick(e); });
    this.compute();
    if ('ResizeObserver' in window) {
      this.ro = new ResizeObserver(() => this.draw());
      this.ro.observe(this.el);
    }
    requestAnimationFrame(() => this.draw());
  }

  destroy() { this.ro?.disconnect(); }

  setResult(g: GaitResult) { this.g = g; this.compute(); this.draw(); }

  setFrame(f: number) {
    if (f === this.frame) return;
    this.frame = f;
    this.draw();
  }

  private compute() {
    const k = this.g.kin;
    for (const s of ['L', 'R'] as Side[]) {
      const a = new Float64Array(k.n);
      for (let f = 0; f < k.n; f++) a[f] = kneeFlex(k, s, f);
      this.knee[s] = a;
    }
    const h = new Float64Array(k.n);
    let sum = 0;
    for (let f = 0; f < k.n; f++) { h[f] = -hipY(k, f) * k.cmPerPx; sum += h[f]; }
    const m = sum / Math.max(1, k.n);
    let lo = Infinity, hi = -Infinity;
    for (let f = 0; f < k.n; f++) { h[f] -= m; lo = Math.min(lo, h[f]); hi = Math.max(hi, h[f]); }
    this.hip = h;
    const pad = Math.max(1, (hi - lo) * 0.15);
    this.hipRange = [lo - pad, hi + pad];
  }

  private plotX(width: number) {
    const left = 34, right = 8;
    return { left, w: Math.max(10, width - left - right) };
  }

  private draw() {
    const cv = this.cv;
    const width = cv.clientWidth;
    if (!width) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const H = 230;
    cv.style.height = `${H}px`;
    if (cv.width !== Math.round(width * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(width * dpr);
      cv.height = Math.round(H * dpr);
    }
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, H);
    const ink = css('--ink', '#14213D'), muted = css('--muted', '#5B6B82'), line = css('--line', '#D5DCE5');
    const k = this.g.kin, n = k.n;
    if (n < 2) return;
    const { left, w } = this.plotX(width);
    const X = (f: number) => left + (f / (n - 1)) * w;

    // Panels.
    const kneeTop = 8, kneeH = 120, barY = kneeTop + kneeH + 6, barH = 14, hipTop = barY + 2 * barH + 14, hipH = H - hipTop - 18;
    const kneeY = (deg: number) => kneeTop + kneeH - (Math.max(0, Math.min(140, deg)) / 140) * kneeH;
    const hipYpx = (cm: number) => hipTop + hipH - ((cm - this.hipRange[0]) / (this.hipRange[1] - this.hipRange[0])) * hipH;

    ctx.font = '11px -apple-system, system-ui, sans-serif';
    ctx.fillStyle = muted;
    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    for (const d of [0, 45, 90, 135]) {
      const y = kneeY(d);
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + w, y); ctx.stroke();
      ctx.fillText(`${d}°`, 2, y + 4);
    }
    ctx.fillText('hip', 2, hipTop + hipH / 2 + 4);

    // Contact bars: one row per foot.
    const near = this.g.nearSide;
    for (const c of this.g.contacts) {
      const row = c.side === 'L' ? 0 : 1;
      ctx.globalAlpha = this.g.view === 'SAGITTAL' && c.side !== near ? 0.45 : 0.9;
      ctx.fillStyle = c.side === 'L' ? INK.L : INK.R;
      const x0 = X(c.ic), x1 = X(c.to);
      ctx.fillRect(x0, barY + row * barH, Math.max(2, x1 - x0), barH - 3);
    }
    ctx.globalAlpha = 1;

    // Knee curves; in side view the far leg is drawn faint.
    for (const s of ['L', 'R'] as Side[]) {
      const a = this.knee[s];
      ctx.strokeStyle = s === 'L' ? INK.L : INK.R;
      ctx.globalAlpha = this.g.view === 'SAGITTAL' && s !== near ? 0.35 : 1;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let f = 0; f < n; f++) { const x = X(f), y = kneeY(a[f]); if (f) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Hip height.
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let f = 0; f < n; f++) { const x = X(f), y = hipYpx(this.hip[f]); if (f) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
    ctx.stroke();

    // Cursor and readout.
    const f = Math.max(0, Math.min(n - 1, this.frame));
    const cx = X(f);
    ctx.strokeStyle = INK.track;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx, kneeTop); ctx.lineTo(cx, hipTop + hipH); ctx.stroke();
    ctx.fillStyle = ink;
    const t = k.t[f] - k.t[0];
    const label = `${t.toFixed(2)} s · knee L ${Math.round(this.knee.L[f])}° R ${Math.round(this.knee.R[f])}°`;
    ctx.fillText(label, left, H - 4);
  }
}
