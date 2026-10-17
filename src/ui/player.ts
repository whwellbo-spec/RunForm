// Video player with a live skeleton overlay, real-time-relative slow motion,
// frame stepping and jump-to-event.
import { hipX, hipY, kneeFlex, leanFromVertical, shoulderX, shoulderY, type Contact } from '../analysis/gait';
import type { PoseTrack } from '../analysis/landmarks';
import type { GaitResult } from '../analysis/metrics';
import { drawSkeleton, INK, type View2D } from './draw';

type EventKind = 'ic' | 'ms' | 'heelLift' | 'to';
const EVENT_NAME: Record<EventKind, string> = { ic: 'Landing', ms: 'Pose', heelLift: 'Fall', to: 'Toe-off' };
const SPEEDS: Array<[number, string]> = [[1, '1×'], [0.5, '½×'], [0.25, '¼×'], [0.125, '⅛×']];

export class Player {
  readonly el: HTMLElement;
  private video: HTMLVideoElement;
  private canvas: HTMLCanvasElement;
  private hud: HTMLElement;
  private scrub: HTMLInputElement;
  private playBtn: HTMLButtonElement;
  private raf = 0;
  private playing = false;
  private speed = 0.25;
  private manual = false;
  private manualT = 0;
  private lastTs = 0;
  private seeking = false;
  private url: string;
  private t0: number;
  private t1: number;

  constructor(file: File, private track: PoseTrack, private g: GaitResult, private factor: number) {
    this.url = URL.createObjectURL(file);
    this.t0 = track.mediaTimeS[0];
    this.t1 = track.mediaTimeS[track.nFrames - 1];
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="player"><div class="player-stage">
        <video playsinline muted preload="auto"></video>
        <canvas></canvas>
        <div class="player-hud"></div>
      </div></div>
      <div class="controls">
        <input class="scrub" type="range" min="0" max="${track.nFrames - 1}" step="1" value="0" aria-label="Position" />
        <div class="row">
          <button type="button" class="btn round" data-act="prev" aria-label="Previous frame">‹</button>
          <button type="button" class="btn btn-primary round" data-act="play" aria-label="Play">▶</button>
          <button type="button" class="btn round" data-act="next" aria-label="Next frame">›</button>
          <span class="grow"></span>
          ${SPEEDS.map(([r, l]) => `<button type="button" class="chip" data-speed="${r}" aria-pressed="${r === this.speed}">${l}</button>`).join('')}
        </div>
        <div class="row">
          ${(g.view === 'SAGITTAL' ? (['ic', 'ms', 'heelLift', 'to'] as EventKind[]) : (['ic', 'ms', 'to'] as EventKind[]))
            .map((e) => `<button type="button" class="chip" data-jump="${e}">${EVENT_NAME[e]}</button>`).join('')}
        </div>
      </div>`;
    this.el = wrap;
    this.video = wrap.querySelector('video')!;
    this.canvas = wrap.querySelector('canvas')!;
    this.hud = wrap.querySelector('.player-hud')!;
    this.scrub = wrap.querySelector('.scrub')!;
    this.playBtn = wrap.querySelector('[data-act=play]')!;
    this.video.src = this.url;
    this.video.addEventListener('loadeddata', () => { this.video.currentTime = this.t0 + 0.0001; });
    this.video.addEventListener('seeked', () => { this.seeking = false; this.draw(); });
    this.video.addEventListener('timeupdate', () => { if (!this.playing) this.draw(); });
    addEventListener('resize', this.onResize);

    wrap.querySelector('[data-act=prev]')!.addEventListener('click', () => this.step(-1));
    wrap.querySelector('[data-act=next]')!.addEventListener('click', () => this.step(1));
    this.playBtn.addEventListener('click', () => (this.playing ? this.pause() : this.play()));
    wrap.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((b) => b.addEventListener('click', () => {
      this.speed = +b.dataset.speed!;
      wrap.querySelectorAll('[data-speed]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      if (this.playing) { this.pause(); this.play(); }
    }));
    wrap.querySelectorAll<HTMLButtonElement>('[data-jump]').forEach((b) => b.addEventListener('click', () => this.jump(b.dataset.jump as EventKind)));
    this.scrub.addEventListener('input', () => { this.pause(); this.seekFrame(+this.scrub.value); });
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    removeEventListener('resize', this.onResize);
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    URL.revokeObjectURL(this.url);
  }

  private onResize = () => this.draw();

  private frameAt(t: number): number {
    const a = this.track.mediaTimeS;
    let lo = 0, hi = a.length - 1;
    if (t <= a[0]) return 0;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (a[m] <= t + 1e-6) lo = m; else hi = m - 1; }
    return lo;
  }

  private seekFrame(f: number) {
    f = Math.max(0, Math.min(this.track.nFrames - 1, f));
    const t = this.track.mediaTimeS[f];
    const next = this.track.mediaTimeS[Math.min(this.track.nFrames - 1, f + 1)];
    this.seeking = true;
    this.video.currentTime = t + Math.max(0.00005, (next - t) * 0.3);
  }

  private step(d: number) {
    this.pause();
    this.seekFrame(this.frameAt(this.video.currentTime) + d);
  }

  private jump(kind: EventKind) {
    this.pause();
    const cur = this.frameAt(this.video.currentTime);
    const frames = this.g.contacts.map((c) => c[kind]).sort((a, b) => a - b);
    const nextF = frames.find((f) => f > cur + 1) ?? frames[0];
    if (nextF !== undefined) this.seekFrame(nextF);
  }

  private play() {
    const pr = this.speed * this.factor;
    this.playing = true;
    this.playBtn.textContent = '❚❚';
    this.playBtn.setAttribute('aria-label', 'Pause');
    if (this.video.currentTime >= this.t1 - 0.001) this.video.currentTime = this.t0;
    this.manual = !(pr >= 0.25 && pr <= 4);
    if (!this.manual) {
      this.video.playbackRate = pr;
      void this.video.play().catch(() => { this.manual = true; });
    }
    this.manualT = this.video.currentTime;
    this.lastTs = performance.now();
    const loop = (ts: number) => {
      if (!this.playing) return;
      if (this.manual) {
        const dt = (ts - this.lastTs) / 1000;
        this.lastTs = ts;
        this.manualT += dt * pr;
        if (this.manualT > this.t1) this.manualT = this.t0;
        if (!this.seeking) { this.seeking = true; this.video.currentTime = this.manualT; }
      } else if (this.video.currentTime >= this.t1) {
        this.video.currentTime = this.t0;
      }
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private pause() {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.video.pause();
    this.playBtn.textContent = '▶';
    this.playBtn.setAttribute('aria-label', 'Play');
  }

  private contactAt(f: number): Contact | undefined {
    return this.g.contacts.find((c) => f >= c.ic && f <= c.to);
  }

  private draw() {
    const v = this.video, cv = this.canvas, k = this.g.kin;
    const w = v.clientWidth, h = v.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const ctx = cv.getContext('2d')!;
    ctx.clearRect(0, 0, cv.width, cv.height);
    const s = Math.min(cv.width / this.track.width, cv.height / this.track.height);
    const offX = (cv.width - this.track.width * s) / 2, offY = (cv.height - this.track.height * s) / 2;
    const view: View2D = { s, ox: -offX / s, oy: -offY / s };
    const f = this.frameAt(v.currentTime);
    this.scrub.value = String(f);
    if (!k.detected[f]) { this.hud.textContent = 'No runner found in this frame'; return; }

    const c = this.contactAt(f);
    if (c && this.g.view === 'SAGITTAL') {
      ctx.save();
      ctx.setLineDash([6 * dpr, 5 * dpr]);
      ctx.strokeStyle = INK.guide; ctx.lineWidth = 1.5 * dpr;
      const hx = (hipX(k, f) - view.ox) * s;
      ctx.beginPath(); ctx.moveTo(hx, (hipY(k, f) - view.oy) * s); ctx.lineTo(hx, (Math.max(k.y[27][f], k.y[28][f], k.y[31][f], k.y[32][f]) - view.oy) * s + 8 * dpr); ctx.stroke();
      ctx.restore();
    }
    drawSkeleton(ctx, k, f, view, 2.5 * dpr);

    const tol = Math.max(1, Math.round(k.fs * 0.012));
    let event = '';
    for (const ct of this.g.contacts) {
      for (const e of ['ic', 'ms', 'heelLift', 'to'] as EventKind[]) {
        if (this.g.view !== 'SAGITTAL' && e === 'heelLift') continue;
        if (Math.abs(ct[e] - f) <= tol) event = `${EVENT_NAME[e]} · ${ct.side === 'L' ? 'left' : 'right'}`;
      }
    }
    const phase = c ? `${c.side === 'L' ? 'Left' : 'Right'} foot down` : 'In the air';
    const knee = `Knee L ${Math.round(kneeFlex(k, 'L', f))}°  R ${Math.round(kneeFlex(k, 'R', f))}°`;
    const trunk = this.g.view === 'SAGITTAL' ? `<br>Trunk ${Math.round(leanFromVertical(k, hipX(k, f), hipY(k, f), shoulderX(k, f), shoulderY(k, f)))}°` : '';
    const realT = this.track.realTimeS[f];
    this.hud.innerHTML = `<span class="phase">${event || phase}</span><br>${knee}${trunk}<br>${realT.toFixed(3)} s`;
  }
}
