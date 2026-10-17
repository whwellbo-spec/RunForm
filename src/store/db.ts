// Session persistence in IndexedDB. Typed arrays are stored natively
// (structured clone), never as arrays of objects.
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { PoseTrack } from '../analysis/landmarks';
import type { TimingSettings } from '../analysis/timing';
import type { ExtractStats } from '../pose/extract';

export type View = 'SAGITTAL' | 'FRONTAL';
export type Surface = 'TREADMILL' | 'OVERGROUND';

export interface ClipTags {
  view: View;
  surface: Surface;
  /** Treadmill belt speed in m/s (null for overground). */
  treadmillSpeedMps: number | null;
}

export interface VideoRef {
  name: string;
  size: number;
  lastModified: number;
  durationS: number;
  nSamples: number;
  codec: string;
}

export interface SessionRecord {
  id: string;
  createdAt: number;
  video: VideoRef;
  tags: ClipTags;
  timing: TimingSettings;
  trim: { presStart: number; presEnd: number };
  extraction: ExtractStats;
  dupThreshold: number;
  track: PoseTrack;
  /** Runner height used for scaling (cm). Older sessions fall back to the current setting. */
  heightCm?: number;
  /** Cached headline result for the history list. */
  score?: number;
  grade?: string;
  /** Annotated key-frame JPEGs (data URLs). */
  stills?: Partial<Record<'landing' | 'pose' | 'fall', string>>;
}

interface RunFormDB extends DBSchema {
  sessions: { key: string; value: SessionRecord; indexes: { createdAt: number } };
}

let dbp: Promise<IDBPDatabase<RunFormDB>> | null = null;

export function db() {
  dbp ??= openDB<RunFormDB>('runform', 1, {
    upgrade(d) {
      const s = d.createObjectStore('sessions', { keyPath: 'id' });
      s.createIndex('createdAt', 'createdAt');
    },
  });
  return dbp;
}

export async function saveSession(s: SessionRecord): Promise<void> {
  await (await db()).put('sessions', s);
}

export async function listSessions(): Promise<SessionRecord[]> {
  return (await db()).getAllFromIndex('sessions', 'createdAt');
}

export async function deleteSession(id: string): Promise<void> {
  await (await db()).delete('sessions', id);
}

/** Does a re-selected file match the stored video reference? */
export function matchesVideoRef(ref: VideoRef, file: File): boolean {
  return file.name === ref.name && file.size === ref.size;
}
