// Fallback extraction when WebCodecs can't decode the codec: seek a <video>
// element frame by frame and verify, via requestVideoFrameCallback's
// mediaTime, that each seek landed on the expected frame.
import type { ClipInfo } from './demux';

export interface SeekedFrame {
  video: HTMLVideoElement;
  presIndex: number;
  /** True if rVFC reported a mediaTime matching the expected frame. */
  verified: boolean;
  /** Reported media time (s), NaN if unknown. */
  mediaTime: number;
}

type RVFCVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
  cancelVideoFrameCallback?: (h: number) => void;
};

export async function loadVideo(file: File): Promise<HTMLVideoElement> {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.src = URL.createObjectURL(file);
  // iOS only decodes for elements that are in the document.
  v.style.cssText = 'position:fixed;left:-10000px;top:0;width:2px;height:2px;';
  document.body.appendChild(v);
  await new Promise<void>((resolve, reject) => {
    v.onloadeddata = () => resolve();
    v.onerror = () => reject(new Error('Video element could not load the file'));
    v.load();
  });
  return v;
}

export function disposeVideo(v: HTMLVideoElement): void {
  URL.revokeObjectURL(v.src);
  v.removeAttribute('src');
  v.load();
  v.remove();
}

/** Seek and wait for the frame to be presented. */
export function seekTo(v: HTMLVideoElement, t: number, timeoutMs = 1500): Promise<number> {
  const rv = v as RVFCVideo;
  return new Promise((resolve) => {
    let done = false;
    let handle = 0;
    const finish = (mt: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      v.removeEventListener('seeked', onSeeked);
      if (handle && rv.cancelVideoFrameCallback) rv.cancelVideoFrameCallback(handle);
      resolve(mt);
    };
    // 'seeked' without an rVFC callback means the presented frame is unknown;
    // give rVFC a moment to arrive before giving up on verification.
    const onSeeked = () => setTimeout(() => finish(NaN), 250);
    const timer = setTimeout(() => finish(NaN), timeoutMs);
    if (rv.requestVideoFrameCallback) handle = rv.requestVideoFrameCallback((_n, meta) => finish(meta.mediaTime));
    v.addEventListener('seeked', onSeeked);
    v.currentTime = t;
  });
}

/**
 * Yield the video element positioned on each frame of [presStart, presEnd].
 * The element is only valid until the next iteration.
 */
export async function* seekFrames(c: ClipInfo, v: HTMLVideoElement, presStart: number, presEnd: number, signal?: AbortSignal): AsyncGenerator<SeekedFrame> {
  for (let p = presStart; p <= presEnd; p++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const t = c.presTimeS[p];
    const nextT = p + 1 < c.nSamples ? c.presTimeS[p + 1] : t + (c.presTimeS[p] - c.presTimeS[Math.max(0, p - 1)] || 1 / 30);
    const frameDur = nextT - t;
    // Aim a quarter into the frame so rounding can't land on the previous one.
    let mt = await seekTo(v, t + frameDur * 0.25);
    let verified = Number.isFinite(mt) && Math.abs(mt - t) < frameDur * 0.5;
    if (!verified && Number.isFinite(mt)) {
      mt = await seekTo(v, t + frameDur * 0.5);
      verified = Math.abs(mt - t) < frameDur * 0.5;
    }
    yield { video: v, presIndex: p, verified, mediaTime: mt };
  }
}
