// In-app recording through RunForm's native camera (iOS app only).
import { Capacitor, registerPlugin } from '@capacitor/core';

export interface RecordResult {
  /** file:// URL of the recording (deleted as soon as it has been read). */
  path: string;
  frames: number;
  dropped: number;
  durationS: number;
  steps: number;
  /** Recording time (s) when running was first seen, and of the last counted step; −1 if unknown. */
  runStartS: number;
  runEndS: number;
  autoStopped: boolean;
}

interface RunCameraPlugin {
  record(options: { targetSteps: number; maxSeconds: number }): Promise<RecordResult>;
  deleteRecording(options: { path: string }): Promise<void>;
}

const RunCamera = registerPlugin<RunCameraPlugin>('RunCamera');

export const canRecord = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';

/** Steps to capture before stopping: ~12 landings per leg. */
export const TARGET_STEPS = 24;

/**
 * Open the camera, record until enough steps are captured, then load the
 * video into memory and delete the file. Returns null if cancelled.
 */
export async function recordRun(): Promise<{ file: File; result: RecordResult } | null> {
  let r: RecordResult;
  try {
    r = await RunCamera.record({ targetSteps: TARGET_STEPS, maxSeconds: 45 });
  } catch (e) {
    if ((e as { code?: string }).code === 'CANCELLED') return null;
    throw e;
  }
  try {
    const resp = await fetch(Capacitor.convertFileSrc(r.path));
    if (!resp.ok) throw new Error(`Couldn't read the recording (${resp.status}).`);
    const blob = await resp.blob();
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.');
    return { file: new File([blob], `RunForm ${stamp}.mp4`, { type: 'video/mp4', lastModified: Date.now() }), result: r };
  } finally {
    // The video only lives in memory from here; nothing is kept on the phone.
    await RunCamera.deleteRecording({ path: r.path }).catch(() => undefined);
  }
}
