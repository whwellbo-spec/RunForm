// Tiny grayscale frame hashes for duplicate-frame detection. Pure, no DOM:
// the caller downsamples the frame to RGBA and passes the pixels in.

export const HASH_W = 64;
export const HASH_H = 36;

/** RGBA -> luma (BT.601), one byte per pixel. */
export function rgbaToGray(rgba: Uint8ClampedArray | Uint8Array, out = new Uint8Array(rgba.length / 4)): Uint8Array {
  for (let i = 0, j = 0; j < out.length; i += 4, j++) {
    out[j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
  }
  return out;
}

export interface HashDiff {
  /** Largest absolute per-pixel difference (0-255). */
  max: number;
  /** Mean absolute per-pixel difference. */
  mean: number;
}

export function hashDiff(a: Uint8Array, b: Uint8Array): HashDiff {
  let max = 0, sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    sum += d;
    if (d > max) max = d;
  }
  return { max, mean: sum / a.length };
}

/**
 * A frame is a duplicate of its predecessor when no downsampled pixel changed
 * by more than `maxThreshold`. Using the max (not the mean) matters: with a
 * static tripod background only the runner's pixels change between real
 * 240 fps frames, so the mean difference of distinct frames can be tiny.
 */
export function isDuplicate(d: HashDiff, maxThreshold = 3): boolean {
  return d.max <= maxThreshold;
}
