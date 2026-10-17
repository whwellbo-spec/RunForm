// Pure helpers for the demuxed sample table: orientation, presentation order,
// edit lists and decode windows. No DOM.

/** Rotation in degrees (0/90/180/270) from a QuickTime/ISO 3x3 track matrix (16.16 fixed). */
export function rotationFromMatrix(m: ArrayLike<number> | undefined): 0 | 90 | 180 | 270 {
  if (!m || m.length < 5) return 0;
  const a = m[0], b = m[1];
  const deg = Math.round((Math.atan2(b, a) * 180) / Math.PI);
  const r = ((deg % 360) + 360) % 360;
  if (r === 90 || r === 180 || r === 270) return r;
  return 0;
}

/**
 * Presentation order: indices of samples (in decode order) sorted by
 * composition time. Returns presOrder[p] = decode index.
 */
export function presentationOrder(cts: ArrayLike<number>): Int32Array {
  const idx = Int32Array.from({ length: cts.length }, (_, i) => i);
  idx.sort((x, y) => cts[x] - cts[y] || x - y);
  return idx;
}

export interface EditEntry { segment_duration: number; media_time: number }

/**
 * Offset that maps composition time (media timescale ticks) to the
 * presentation timeline in seconds, as a <video> element reports currentTime:
 * t = (cts - mediaTime) / timescale + emptyLeadIn.
 */
export function editListMapping(edits: EditEntry[] | undefined, timescale: number, movieTimescale: number): { mediaTime: number; leadInS: number } {
  let leadInS = 0;
  if (edits) {
    for (const e of edits) {
      if (e.media_time === -1) { leadInS += e.segment_duration / movieTimescale; continue; }
      return { mediaTime: e.media_time, leadInS };
    }
  }
  void timescale;
  return { mediaTime: 0, leadInS };
}

export interface DecodeWindow {
  /** First decode index to feed (a sync sample). */
  feedStart: number;
  /** Last decode index to feed (inclusive). */
  feedEnd: number;
}

/**
 * Decode-order range that must be fed to the decoder to obtain all frames of
 * presentation indices [presStart, presEnd]: from the last sync sample at or
 * before the earliest needed sample, through the latest needed sample.
 */
export function decodeWindow(presOrder: ArrayLike<number>, isSync: ArrayLike<number | boolean>, presStart: number, presEnd: number): DecodeWindow {
  let minDec = Infinity, maxDec = -Infinity;
  for (let p = presStart; p <= presEnd; p++) {
    const d = presOrder[p];
    if (d < minDec) minDec = d;
    if (d > maxDec) maxDec = d;
  }
  let feedStart = minDec;
  while (feedStart > 0 && !isSync[feedStart]) feedStart--;
  return { feedStart, feedEnd: maxDec };
}

/** Search for slow-motion hints in raw moov bytes (ASCII, case-insensitive). */
export function findSlowmoHints(bytes: Uint8Array): string[] {
  const needles = ['slowmo', 'slow-mo', 'slow_motion', 'slowmotion', 'slow-motion'];
  // Lower-case ASCII copy for matching.
  let text = '';
  const CH = 8192;
  for (let i = 0; i < bytes.length; i += CH) {
    const sub = bytes.subarray(i, Math.min(bytes.length, i + CH));
    const arr = new Array<number>(sub.length);
    for (let j = 0; j < sub.length; j++) {
      const c = sub[j];
      arr[j] = c >= 65 && c <= 90 ? c + 32 : c >= 32 && c < 127 ? c : 46;
    }
    text += String.fromCharCode(...arr);
  }
  return needles.filter((n) => text.includes(n));
}
