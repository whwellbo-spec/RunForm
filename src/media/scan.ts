// Import-time duplicate-frame scan: decode every sample, hash it, compare with
// the previous frame. Frames are closed immediately; only hashes are kept.
import { hashDiff } from '../analysis/framehash';
import { decodeFrames } from './decode';
import type { ClipInfo } from './demux';
import { FrameHasher } from './frames';

export interface ScanResult {
  /** Max per-pixel hash difference to the previous frame, by presentation index (NaN for frame 0). */
  diffMax: Float32Array;
  framesDecoded: number;
  elapsedS: number;
}

export async function scanDuplicates(
  c: ClipInfo, signal: AbortSignal, onProgress: (done: number, total: number) => void,
): Promise<ScanResult> {
  const diffMax = new Float32Array(c.nSamples).fill(NaN);
  const hasher = new FrameHasher();
  let prev: Uint8Array | null = null;
  let done = 0;
  const t0 = performance.now();
  for await (const { frame, presIndex } of decodeFrames(c, 0, c.nSamples - 1, { signal })) {
    const h = hasher.hash(frame);
    frame.close();
    if (prev) diffMax[presIndex] = hashDiff(prev, h).max;
    prev = h;
    done++;
    if (done % 30 === 0) {
      onProgress(done, c.nSamples);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  onProgress(done, c.nSamples);
  return { diffMax, framesDecoded: done, elapsedS: (performance.now() - t0) / 1000 };
}

export function countDuplicates(diffMax: Float32Array, start: number, end: number, threshold: number): number {
  let n = 0;
  for (let p = Math.max(1, start + 1); p <= end; p++) if (diffMax[p] <= threshold) n++;
  return n;
}
