// Video player with a live skeleton overlay, real-time-relative slow motion,
// frame stepping, jump-to-event, and hand correction of foot contacts.
import { hipX, hipY, kneeFlex, leanFromVertical, shoulderX, shoulderY, type Contact, type Side } from '../analysis/gait';
import type { PoseTrack } from '../analysis/landmarks';
import type { ContactEdit, GaitResult } from '../analysis/metrics';
import { drawSkeleton, INK, type View2D } from './draw';

export type EventKind = 'ic' | 'ms' | 'heelLift' | 'to';
const EVENT_NAME: Record<EventKind, string> = { ic: 'Landing', ms: 'Pose', heelLift: 'Fall', to: 'Toe-off' };
const SPEEDS: Array<[number, string]> = [[1, '1×'], [0.5, '½×'], [0.25, '¼×'], [0.125, '⅛×']];

export interface PlayerOptions {
  /** Show the foot-contact correction tools. */
  editable?: boolean;
  /** Called with the full corrected contact list after each change (null = edits undone). */
  onEdit?: (edits: ContactEdit[] | null) => void;
  /** Called when the user taps "Update report" after editing. */
  onDone?: () => void;
  /** Called on every drawn frame (track frame index). */
  onFrame?: (frame: number) => void;
  /** Label shown above the video (comparison view). */
  title?: string;
}

export class Player {
  readonly el: HTMLElement;
  private video: HTMLVideoElement;
  private canvas: HTMLCanvasElement;
  private hud: HTMLElement;
  private scrub: HTMLInputElement;
  private playBtn: HTMLButtonElement;
  private editMsg: HTMLElement | null = null;
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
  private editSide: Side;
  private edits: ContactEdit[] | null = null;

  constructor(readonly file: File, private track: PoseTrack, private g: GaitResult, private factor: number, private opts: PlayerOptions = {}) {
    this.url = URL.createObjectURL(file);
    this.t0 = track.mediaTimeS[0];
    this.t1 = track.mediaTimeS[track.nFrames - 1];
    this.editSide = g.nearSide;
    const wrap = document.createElement('div');
    wrap.className = 'player-wrap';
    const events: EventKind[] = g.view === 'SAGITTAL' ? ['ic', 'ms', 'heelLift', 'to'] : ['ic', 'ms', 'to'];
    wrap.innerHTML = `
      ${opts.title ? `<p class="player-title">${opts.title}</p>` : ''}
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
          ${events.map((e) => `<button type="button" class="chip" data-jump="${e}">${EVENT_NAME[e]}</button>`).join('')}
          ${opts.editable ? '<span class="grow"></span><button type="button" class="chip" data-act="edit" aria-pressed="false">Fix contacts</button>' : ''}
        </div>
        ${opts.editable ? `
        <div class="edit-panel" hidden>
          <p class="fine">Step to the exact frame, pick the foot, then set the landing or toe-off. Changes apply to that foot’s nearest contact.</p>
          <div class="row">
            <span class="fine">Foot</span>
            <button type="button" class="chip" data-eside="L" aria-pressed="${this.editSide === 'L'}">Left</button>
            <button type="button" class="chip" data-eside="R" aria-pressed="${this.editSide === 'R'}">Right</button>
          </div>
          <div class="row">
            <button type="button" class="chip" data-op="ic">Landing here</button>
            <button type="button" class="chip" data-op="to">Toe-off here</button>
            <button type="button" class="chip" data-op="add">Add contact</button>
            <button type="button" class="chip" data-op="del">Delete contact</button>
          </div>
          <p class="fine edit-msg" role="status"></p>
          <div class="btn-row">
            <button type="button" class="btn" data-op="reset">Undo all edits</button>
            <button type="button" class="btn btn-primary" data-op="done">Update report</button>
          </div>
        </div>` : ''}
      </div>`;
    this.el = wrap;
    this.video = wrap.querySelector('video')!;
    this.canvas = wrap.querySelector('canvas')!;
    this.hud = wrap.querySelector('.player-hud')!;
    this.scrub = wrap.querySelector('.scrub')!;
    this.playBtn = wrap.querySelector('[data-act=play]')!;
    this.editMsg = wrap.querySelector('.edit-msg');
    this.video.src = this.url;
    this.video.addEventListener('loadeddata', () => { this.video.currentTime = this.t0 + 0.0001; });
    this.video.addEventListener('seeked', () => { this.seeking = false; this.draw(); });
    this.video.addEventListener('timeupdate', () => { if (!this.playing) this.draw(); });
    addEventListener('resize', this.onResize);

    wrap.querySelector('[data-act=prev]')!.addEventListener('click', () => this.step(-1));
    wrap.querySelector('[data-act=next]')!.addEventListener('click', () => this.step(1));
    this.playBtn.addEventListener('click', () => (this.playing ? this.pause() : this.play()));
    wrap.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((b) => b.addEventListener('click', () => this.setSpeed(+b.dataset.speed!)));
    wrap.querySelectorAll<HTMLButtonElement>('[data-jump]').forEach((b) => b.addEventListener('click', () => this.jump(b.dataset.jump as EventKind)));
    this.scrub.addEventListener('input', () => { this.pause(); this.seek(+this.scrub.value); });

    if (opts.editable) {
      const panel = wrap.querySelector<HTMLElement>('.edit-panel')!;
      const toggle = wrap.querySelector<HTMLButtonElement>('[data-act=edit]')!;
      toggle.addEventListener('click', () => {
        panel.hidden = !panel.hidden;
        toggle.setAttribute('aria-pressed', String(!panel.hidden));
        if (!panel.hidden) this.pause();
      });
      wrap.querySelectorAll<HTMLButtonElement>('[data-eside]').forEach((b) => b.addEventListener('click', () => {
        this.editSide = b.dataset.eside as Side;
        wrap.querySelectorAll('[data-eside]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        this.draw();
      }));
      wrap.querySelectorAll<HTMLButtonElement>('[data-op]').forEach((b) => b.addEventListener('click', () => this.editOp(b.dataset.op!)));
    }
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    removeEventListener('resize', this.onResize);
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    URL.revokeObjectURL(this.url);
  }

  /** Swap in a recomputed analysis (after edits). */
  setResult(g: GaitResult) {
    this.g = g;
    this.draw();
  }

  get currentFrame(): number { return this.frameAt(this.video.currentTime); }

  setSpeed(r: number) {
    this.speed = r;
    this.el.querySelectorAll('[data-speed]').forEach((x) => x.setAttribute('aria-pressed', String(+(x as HTMLElement).dataset.speed! === r)));
    if (this.playing) { this.pause(); this.play(); }
  }

  private onResize = () => this.draw();

  private frameAt(t: number): number {
    const a = this.track.mediaTimeS;
    let lo = 0, hi = a.length - 1;
    if (t <= a[0]) return 0;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (a[m] <= t + 1e-6) lo = m; else hi = m - 1; }
    return lo;
  }

  /** Show track frame f. */
  seek(f: number) {
    f = Math.max(0, Math.min(this.track.nFrames - 1, Math.round(f)));
    const t = this.track.mediaTimeS[f];
    const next = this.track.mediaTimeS[Math.min(this.track.nFrames - 1, f + 1)];
    this.seeking = true;
    this.video.currentTime = t + Math.max(0.00005, (next - t) * 0.3);
  }

  step(d: number) {
    this.pause();
    this.seek(this.currentFrame + d);
  }

  private jump(kind: EventKind) {
    this.pause();
    const cur = this.currentFrame;
    const frames = this.g.contacts.map((c) => c[kind]).sort((a, b) => a - b);
    const nextF = frames.find((f) => f > cur + 1) ?? frames[0];
    if (nextF !== undefined) this.seek(nextF);
  }

  /**
   * Go to the index-th event of this kind on the leg nearer the camera (side
   * view) — used to line two runs up at the same moment of the stride.
   * Returns false if there is no such event.
   */
  jumpToEvent(kind: EventKind, index: number): boolean {
    this.pause();
    const pool = this.g.view === 'SAGITTAL' ? this.g.contacts.filter((c) => c.side === this.g.nearSide) : this.g.contacts;
    const c = pool[index];
    if (!c) return false;
    this.seek(c[kind]);
    return true;
  }

  eventCount(): number {
    return (this.g.view === 'SAGITTAL' ? this.g.contacts.filter((c) => c.side === this.g.nearSide) : this.g.contacts).length;
  }

  play() {
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

  pause() {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.video.pause();
    this.playBtn.textContent = '▶';
    this.playBtn.setAttribute('aria-label', 'Play');
  }

  // ---------- contact editing ----------

  private say(msg: string) { if (this.editMsg) this.editMsg.textContent = msg; }

  private currentEdits(): ContactEdit[] {
    this.edits ??= this.g.contacts.map((c) => ({ side: c.side, ic: c.ic, to: c.to }));
    return this.edits;
  }

  /** Nearest contact of the chosen foot to frame f (0 distance if f is inside it). */
  private nearest(list: ContactEdit[], f: number): ContactEdit | undefined {
    let best: ContactEdit | undefined, bd = Infinity;
    for (const c of list) {
      if (c.side !== this.editSide) continue;
      const d = f < c.ic ? c.ic - f : f > c.to ? f - c.to : 0;
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  private editOp(op: string) {
    const fs = this.g.kin.fs;
    const foot = this.editSide === 'L' ? 'left' : 'right';
    if (op === 'reset') {
      this.edits = null;
      this.say('Back to the automatic contacts.');
      this.opts.onEdit?.(null);
      return;
    }
    if (op === 'done') { this.opts.onDone?.(); return; }
    const f = this.currentFrame;
    const list = this.currentEdits();
    const c = this.nearest(list, f);
    const minLen = Math.max(2, Math.round(0.05 * fs));
    if (op === 'ic') {
      if (!c) { this.say(`No ${foot} contact yet. Use “Add contact”.`); return; }
      if (f > c.to - minLen) { this.say('Landing has to come before that contact’s toe-off.'); return; }
      c.ic = f;
      this.say(`Moved the ${foot} landing.`);
    } else if (op === 'to') {
      if (!c) { this.say(`No ${foot} contact yet. Use “Add contact”.`); return; }
      if (f < c.ic + minLen) { this.say('Toe-off has to come after that contact’s landing.'); return; }
      c.to = f;
      this.say(`Moved the ${foot} toe-off.`);
    } else if (op === 'add') {
      const same = list.filter((x) => x.side === this.editSide);
      const durs = same.map((x) => x.to - x.ic).sort((a, b) => a - b);
      const dur = durs.length ? durs[durs.length >> 1] : Math.round(0.24 * fs);
      const to = Math.min(this.track.nFrames - 1, f + dur);
      if (same.some((x) => f <= x.to && to >= x.ic)) { this.say(`That overlaps an existing ${foot} contact. Move its landing or toe-off instead.`); return; }
      list.push({ side: this.editSide, ic: f, to });
      list.sort((a, b) => a.ic - b.ic);
      this.say(`Added a ${foot} contact here. Set its toe-off on the right frame.`);
    } else if (op === 'del') {
      if (!c || f < c.ic - Math.round(0.1 * fs) || f > c.to + Math.round(0.1 * fs)) { this.say(`Move onto the ${foot} contact you want to delete.`); return; }
      list.splice(list.indexOf(c), 1);
      this.say(`Deleted that ${foot} contact.`);
    }
    this.opts.onEdit?.(list.map((x) => ({ ...x })));
  }

  // ---------- drawing ----------

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
    this.opts.onFrame?.(f);
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
    const edited = this.g.contactsEdited ? '<br><span class="phase">Contacts edited</span>' : '';
    this.hud.innerHTML = `<span class="phase">${event || phase}</span><br>${knee}${trunk}<br>${realT.toFixed(3)} s${edited}`;
  }
}
