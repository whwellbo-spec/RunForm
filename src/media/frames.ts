// Unified frame source over both extraction paths, plus orientation-correct
// drawing into a work canvas and frame hashing.
import { HASH_H, HASH_W, rgbaToGray } from '../analysis/framehash';
import { decodeFrames } from './decode';
import type { ClipInfo } from './demux';
import { seekFrames } from './seek';

export type ExtractionPath = 'webcodecs' | 'seek';

export interface SourceFrame {
  presIndex: number;
  /** Draw the frame, display-oriented, filling the given context's canvas. */
  draw(ctx: CanvasRenderingContext2D): void;
  /** Hash of the source image (same method as the import scan). */
  hash(h: FrameHasher): Uint8Array;
  close(): void;
  /** Seek path only: whether the seek was verified to land on this frame. */
  verified?: boolean;
}

export async function* sourceFrames(
  c: ClipInfo, path: ExtractionPath, presStart: number, presEnd: number, signal: AbortSignal, video?: HTMLVideoElement,
): AsyncGenerator<SourceFrame> {
  if (path === 'webcodecs') {
    for await (const { frame, presIndex } of decodeFrames(c, presStart, presEnd, { signal })) {
      yield { presIndex, draw: (ctx) => drawRotated(ctx, frame, c), hash: (h) => h.hash(frame), close: () => frame.close() };
    }
  } else {
    if (!video) throw new Error('Seek path needs a video element');
    for await (const s of seekFrames(c, video, presStart, presEnd, signal)) {
      yield {
        presIndex: s.presIndex,
        verified: s.verified,
        // The <video> element already applies the track rotation.
        draw: (ctx) => ctx.drawImage(s.video, 0, 0, ctx.canvas.width, ctx.canvas.height),
        hash: (h) => h.hash(s.video),
        close: () => {},
      };
    }
  }
}

/** Draw a decoded (un-rotated) VideoFrame applying the track's rotation. */
export function drawRotated(ctx: CanvasRenderingContext2D, frame: VideoFrame, c: ClipInfo): void {
  const w = c.codedWidth, h = c.codedHeight;
  ctx.save();
  switch (c.rotation) {
    case 90: ctx.setTransform(0, 1, -1, 0, h, 0); break;
    case 180: ctx.setTransform(-1, 0, 0, -1, w, h); break;
    case 270: ctx.setTransform(0, -1, 1, 0, 0, w); break;
    default: ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  ctx.drawImage(frame, 0, 0, w, h);
  ctx.restore();
}

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  return cv;
}

/** Downsampled grayscale hash of a canvas or frame. Only the hash is kept. */
export class FrameHasher {
  private ctx: CanvasRenderingContext2D;
  constructor() {
    const cv = makeCanvas(HASH_W, HASH_H);
    this.ctx = cv.getContext('2d', { willReadFrequently: true })!;
  }
  hash(src: CanvasImageSource): Uint8Array {
    this.ctx.drawImage(src, 0, 0, HASH_W, HASH_H);
    return rgbaToGray(this.ctx.getImageData(0, 0, HASH_W, HASH_H).data);
  }
}
