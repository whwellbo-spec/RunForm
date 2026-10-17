// Pose extraction over the trimmed window. Resumable: pausing tears down the
// decoder; resuming restarts decoding from the keyframe before the next
// unprocessed frame. Only landmark data is kept in memory.
import { hashDiff, isDuplicate } from '../analysis/framehash';
import { allocPoseTrack, writeFrame, type PoseTrack } from '../analysis/landmarks';
import { toRealTime, type TimingSettings } from '../analysis/timing';
import type { ClipInfo } from '../media/demux';
import { FrameHasher, makeCanvas, sourceFrames, type ExtractionPath } from '../media/frames';
import { disposeVideo, loadVideo } from '../media/seek';
import { createLandmarker, type Landmarker, type ModelVariant } from './landmarker';

export interface ExtractParams {
  clip: ClipInfo;
  path: ExtractionPath;
  presStart: number;
  presEnd: number;
  timing: TimingSettings;
  model: ModelVariant;
  dupThreshold: number;
}

export interface ExtractProgress {
  done: number;
  total: number;
  fps: number;
  etaS: number;
}

export type ExtractState = 'idle' | 'loading' | 'running' | 'paused' | 'done' | 'cancelled' | 'error';

export interface ExtractStats {
  delegate: 'GPU' | 'CPU';
  gpuError?: string;
  model: ModelVariant;
  path: ExtractionPath;
  /** Seek path: frames whose seek could not be verified. */
  unverifiedFrames: number;
  elapsedS: number;
  pauses: number;
}

export class Extractor {
  state: ExtractState = 'idle';
  track: PoseTrack;
  error?: unknown;
  stats: ExtractStats;
  onProgress?: (p: ExtractProgress) => void;
  onState?: (s: ExtractState) => void;
  /** Called every few frames with the work canvas for a live preview. */
  onPreview?: (canvas: HTMLCanvasElement, track: PoseTrack, frame: number) => void;

  private nextFrame = 0; // index into the window
  private abort: AbortController | null = null;
  private stopReason: 'pause' | 'cancel' | null = null;
  private lm: Landmarker | null = null;
  private video?: HTMLVideoElement;
  private hasher = new FrameHasher();
  private prevHash: Uint8Array | null = null;
  private lastTsMs = -Infinity;
  private work: HTMLCanvasElement;
  private workCtx: CanvasRenderingContext2D;
  private activeMs = 0;
  private rate = { t: 0, n: 0, fps: 0 };

  constructor(private p: ExtractParams) {
    const n = p.presEnd - p.presStart + 1;
    this.track = allocPoseTrack(n, p.clip.width, p.clip.height);
    const real = toRealTime(p.clip.presTimeS, p.presStart, p.presEnd, p.timing.slowmoFactor);
    for (let i = 0; i < n; i++) {
      this.track.frameIndex[i] = p.presStart + i;
      this.track.mediaTimeS[i] = p.clip.presTimeS[p.presStart + i];
      this.track.realTimeS[i] = real[i];
    }
    this.work = makeCanvas(p.clip.width, p.clip.height);
    this.workCtx = this.work.getContext('2d', { willReadFrequently: false })!;
    this.stats = { delegate: 'CPU', model: p.model, path: p.path, unverifiedFrames: 0, elapsedS: 0, pauses: 0 };
  }

  get total() { return this.track.nFrames; }

  async start(): Promise<void> {
    this.setState('loading');
    try {
      this.lm = await createLandmarker(this.p.model);
      this.stats.delegate = this.lm.delegate;
      this.stats.gpuError = this.lm.gpuError;
      if (this.p.path === 'seek') {
        this.video = await loadVideo(this.p.clip.file);
        if (this.video.videoWidth !== this.work.width || this.video.videoHeight !== this.work.height) {
          // Use whatever orientation the element presents.
          this.work.width = this.video.videoWidth;
          this.work.height = this.video.videoHeight;
          this.track.width = this.work.width;
          this.track.height = this.work.height;
        }
      }
    } catch (e) {
      this.fail(e);
      return;
    }
    await this.run();
  }

  /** Pause (e.g. page hidden). Progress is kept; call resume() to continue. */
  pause(): void {
    if (this.state !== 'running') return;
    this.stopReason = 'pause';
    this.abort?.abort();
  }

  async resume(): Promise<void> {
    if (this.state !== 'paused') return;
    await this.run();
  }

  cancel(): void {
    if (this.state === 'running') {
      this.stopReason = 'cancel';
      this.abort?.abort();
    } else if (this.state === 'paused' || this.state === 'loading') {
      this.setState('cancelled');
      this.cleanup();
    }
  }

  private async run(): Promise<void> {
    this.abort = new AbortController();
    this.stopReason = null;
    this.setState('running');
    const t0 = performance.now();
    this.rate = { t: t0, n: 0, fps: this.rate.fps };
    const { clip, presStart, presEnd, path } = this.p;
    try {
      const from = presStart + this.nextFrame;
      for await (const sf of sourceFrames(clip, path, from, presEnd, this.abort.signal, this.video)) {
        const i = sf.presIndex - presStart;
        let h: Uint8Array;
        try {
          sf.draw(this.workCtx);
          h = sf.hash(this.hasher);
        } finally {
          sf.close(); // release the decoded frame immediately
        }
        if (sf.verified === false) this.stats.unverifiedFrames++;

        if (this.prevHash && isDuplicate(hashDiff(this.prevHash, h), this.p.dupThreshold)) this.track.duplicate[i] = 1;
        this.prevHash = h;

        await this.detect(i);
        this.nextFrame = i + 1;
        this.tick();
        if (i % 8 === 0) {
          this.onPreview?.(this.work, this.track, i);
          // Yield so the UI can repaint and handle taps.
          await new Promise((r) => setTimeout(r, 0));
        }
        if (this.abort.signal.aborted) break;
      }
      this.activeMs += performance.now() - t0;
      if (this.stopReason) { this.handleStop(); return; }
      this.stats.elapsedS = this.activeMs / 1000;
      this.setState('done');
      this.cleanup();
    } catch (e) {
      this.activeMs += performance.now() - t0;
      if (this.stopReason) { this.handleStop(); return; }
      this.fail(e);
    }
  }

  private async detect(i: number): Promise<void> {
    // VIDEO mode needs strictly increasing timestamps; use real time.
    let ts = this.track.realTimeS[i] * 1000;
    if (ts <= this.lastTsMs) ts = this.lastTsMs + 0.001;
    this.lastTsMs = ts;
    try {
      const r = this.lm!.pose.detectForVideo(this.work, ts);
      writeFrame(this.track, i, r.landmarks[0], r.worldLandmarks[0]);
    } catch (e) {
      if (this.lm!.delegate !== 'GPU') throw e;
      // GPU inference failed (e.g. lost WebGL context): fall back to CPU and retry this frame.
      console.warn('GPU inference failed, switching to CPU', e);
      this.lm!.pose.close();
      this.lm = await createLandmarker(this.p.model, false);
      this.stats.delegate = 'CPU';
      this.stats.gpuError = `inference: ${String(e)}`;
      const r = this.lm.pose.detectForVideo(this.work, ts);
      writeFrame(this.track, i, r.landmarks[0], r.worldLandmarks[0]);
    }
  }

  private tick() {
    const now = performance.now();
    this.rate.n++;
    const dt = now - this.rate.t;
    if (dt >= 1000) {
      const inst = (this.rate.n * 1000) / dt;
      this.rate.fps = this.rate.fps ? 0.6 * this.rate.fps + 0.4 * inst : inst;
      this.rate.t = now;
      this.rate.n = 0;
    }
    const remaining = this.total - this.nextFrame;
    this.onProgress?.({ done: this.nextFrame, total: this.total, fps: this.rate.fps, etaS: this.rate.fps ? remaining / this.rate.fps : NaN });
  }

  private handleStop() {
    if (this.stopReason === 'pause') {
      this.stats.pauses++;
      this.setState('paused');
    } else {
      this.setState('cancelled');
      this.cleanup();
    }
  }

  private fail(e: unknown) {
    console.error(e);
    this.error = e;
    this.setState('error');
    this.cleanup();
  }

  private cleanup() {
    this.lm?.pose.close();
    this.lm = null;
    if (this.video) { disposeVideo(this.video); this.video = undefined; }
  }

  private setState(s: ExtractState) { this.state = s; this.onState?.(s); }
}
