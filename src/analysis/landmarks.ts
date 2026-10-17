// Typed-array layout for per-frame pose landmarks: frame × landmark × field.
// Pure, no DOM.

export const NUM_LANDMARKS = 33;
/** Fields per landmark: x, y, z, visibility. */
export const NUM_FIELDS = 4;
export const STRIDE = NUM_LANDMARKS * NUM_FIELDS;

export const Field = { X: 0, Y: 1, Z: 2, VIS: 3 } as const;

/** BlazePose landmark indices. */
export const LM = {
  NOSE: 0,
  L_EYE_INNER: 1, L_EYE: 2, L_EYE_OUTER: 3, R_EYE_INNER: 4, R_EYE: 5, R_EYE_OUTER: 6,
  L_EAR: 7, R_EAR: 8, MOUTH_L: 9, MOUTH_R: 10,
  L_SHOULDER: 11, R_SHOULDER: 12, L_ELBOW: 13, R_ELBOW: 14, L_WRIST: 15, R_WRIST: 16,
  L_PINKY: 17, R_PINKY: 18, L_INDEX: 19, R_INDEX: 20, L_THUMB: 21, R_THUMB: 22,
  L_HIP: 23, R_HIP: 24, L_KNEE: 25, R_KNEE: 26, L_ANKLE: 27, R_ANKLE: 28,
  L_HEEL: 29, R_HEEL: 30, L_FOOT_INDEX: 31, R_FOOT_INDEX: 32,
} as const;

/** Skeleton connections used for drawing. */
export const CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [27, 29], [29, 31], [27, 31],
  [24, 26], [26, 28], [28, 30], [30, 32], [28, 32],
  [0, 11], [0, 12],
];

/** Per-frame pose data for one analysed window, all typed arrays. */
export interface PoseTrack {
  nFrames: number;
  /** Display-oriented frame size in pixels (after rotation). */
  width: number;
  height: number;
  /** Presentation index of each frame in the source clip. */
  frameIndex: Int32Array;
  /** Presentation time on the file timeline (s). */
  mediaTimeS: Float64Array;
  /** Real-world time from the first window frame (s). */
  realTimeS: Float64Array;
  /** 1 if a pose was detected on this frame. */
  detected: Uint8Array;
  /** 1 if the frame duplicates its predecessor (by frame hash). */
  duplicate: Uint8Array;
  /** Normalized image coords [0..1], z in MediaPipe's normalized scale. */
  norm: Float32Array;
  /** Pixel coords: x*width, y*height, z*width. */
  px: Float32Array;
  /** MediaPipe world landmarks in metres (hip-centred). */
  world: Float32Array;
}

export function allocPoseTrack(nFrames: number, width: number, height: number): PoseTrack {
  return {
    nFrames, width, height,
    frameIndex: new Int32Array(nFrames),
    mediaTimeS: new Float64Array(nFrames),
    realTimeS: new Float64Array(nFrames),
    detected: new Uint8Array(nFrames),
    duplicate: new Uint8Array(nFrames),
    norm: new Float32Array(nFrames * STRIDE).fill(NaN),
    px: new Float32Array(nFrames * STRIDE).fill(NaN),
    world: new Float32Array(nFrames * STRIDE).fill(NaN),
  };
}

export function offset(frame: number, landmark: number, field: number = Field.X): number {
  return frame * STRIDE + landmark * NUM_FIELDS + field;
}

export interface LandmarkLike { x: number; y: number; z: number; visibility?: number }

/** Write one frame's landmarks into the track. */
export function writeFrame(
  t: PoseTrack, frame: number, lms: ReadonlyArray<LandmarkLike> | undefined, world: ReadonlyArray<LandmarkLike> | undefined,
): void {
  if (!lms || lms.length < NUM_LANDMARKS) {
    t.detected[frame] = 0;
    return;
  }
  t.detected[frame] = 1;
  const base = frame * STRIDE;
  for (let i = 0; i < NUM_LANDMARKS; i++) {
    const l = lms[i];
    const o = base + i * NUM_FIELDS;
    const vis = l.visibility ?? NaN;
    t.norm[o] = l.x; t.norm[o + 1] = l.y; t.norm[o + 2] = l.z; t.norm[o + 3] = vis;
    t.px[o] = l.x * t.width; t.px[o + 1] = l.y * t.height; t.px[o + 2] = l.z * t.width; t.px[o + 3] = vis;
    const w = world?.[i];
    if (w) { t.world[o] = w.x; t.world[o + 1] = w.y; t.world[o + 2] = w.z; t.world[o + 3] = w.visibility ?? vis; }
  }
}

/** Mean visibility of a landmark over detected frames. */
export function meanVisibility(t: PoseTrack, landmark: number): number {
  let s = 0, n = 0;
  for (let f = 0; f < t.nFrames; f++) {
    if (!t.detected[f]) continue;
    s += t.norm[offset(f, landmark, Field.VIS)];
    n++;
  }
  return n ? s / n : NaN;
}
