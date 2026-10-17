import { describe, expect, it } from 'vitest';
import { decodeWindow, editListMapping, findSlowmoHints, presentationOrder, rotationFromMatrix } from '../src/media/clipmath';

const F = 65536;
describe('rotationFromMatrix', () => {
  it('reads the four orientations', () => {
    expect(rotationFromMatrix([F, 0, 0, 0, F, 0, 0, 0, 1 << 30])).toBe(0);
    expect(rotationFromMatrix([0, F, 0, -F, 0, 0, 0, 0, 1 << 30])).toBe(90);
    expect(rotationFromMatrix([-F, 0, 0, 0, -F, 0, 0, 0, 1 << 30])).toBe(180);
    expect(rotationFromMatrix([0, -F, 0, F, 0, 0, 0, 0, 1 << 30])).toBe(270);
    expect(rotationFromMatrix(undefined)).toBe(0);
  });
});

describe('presentation order and decode windows', () => {
  // I P B B P B B (decode order) with B-frame reordering, 64 ticks per frame.
  //          dec idx: 0    1    2    3    4    5    6
  const cts = [128, 320, 192, 256, 512, 384, 448];
  const sync = [1, 0, 0, 0, 0, 0, 0];

  it('sorts by composition time', () => {
    expect(Array.from(presentationOrder(cts))).toEqual([0, 2, 3, 1, 5, 6, 4]);
  });

  it('feeds from the preceding keyframe through the last needed sample', () => {
    const po = presentationOrder(cts);
    // Presentation frames 3..4 are decode indices 1 and 5.
    expect(decodeWindow(po, sync, 3, 4)).toEqual({ feedStart: 0, feedEnd: 5 });
    const sync2 = [1, 0, 0, 0, 1, 0, 0];
    // Presentation 5..6 = decode 6, 4 -> start at keyframe 4.
    expect(decodeWindow(po, sync2, 5, 6)).toEqual({ feedStart: 4, feedEnd: 6 });
  });

  it('maps edit lists to the element timeline', () => {
    expect(editListMapping([{ segment_duration: 3000, media_time: 128 }], 15360, 1000)).toEqual({ mediaTime: 128, leadInS: 0 });
    expect(editListMapping([{ segment_duration: 500, media_time: -1 }, { segment_duration: 3000, media_time: 0 }], 600, 1000))
      .toEqual({ mediaTime: 0, leadInS: 0.5 });
    expect(editListMapping(undefined, 600, 600)).toEqual({ mediaTime: 0, leadInS: 0 });
  });
});

describe('findSlowmoHints', () => {
  it('finds ASCII markers case-insensitively', () => {
    const bytes = new TextEncoder().encode('\0\0moov....com.apple.quicktime.SlowMo....');
    expect(findSlowmoHints(bytes)).toContain('slowmo');
    expect(findSlowmoHints(new TextEncoder().encode('nothing here'))).toEqual([]);
  });
});
