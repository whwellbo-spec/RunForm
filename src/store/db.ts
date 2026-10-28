// Session persistence in IndexedDB. Typed arrays are stored natively
// (structured clone), never as arrays of objects.
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { PoseTrack } from '../analysis/landmarks';
import type { ContactEdit } from '../analysis/metrics';
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
  /** 'camera' = recorded in the app (deleted after analysis), 'file' = picked from Photos/Files. */
  source?: 'camera' | 'file';
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
  /** Which runner this was (profiles). Missing = the default runner. */
  runnerId?: string;
  /** Hand-corrected foot contacts; replaces automatic detection when present. */
  contactEdits?: ContactEdit[];
  /** Cached headline numbers for the history list and trend chart. */
  cache?: SessionCache;
}

export interface SessionCache {
  v: number;
  score: number;
  metrics: Record<string, number>;
  speedMps: number | null;
}

export interface Runner {
  id: string;
  name: string;
  heightCm: number;
  createdAt: number;
}
export const DEFAULT_RUNNER_ID = 'me';

interface RunFormDB extends DBSchema {
  sessions: { key: string; value: SessionRecord; indexes: { createdAt: number } };
  runners: { key: string; value: Runner };
}

let dbp: Promise<IDBPDatabase<RunFormDB>> | null = null;

export function db() {
  dbp ??= openDB<RunFormDB>('runform', 2, {
    upgrade(d, oldVersion) {
      if (oldVersion < 1) {
        const s = d.createObjectStore('sessions', { keyPath: 'id' });
        s.createIndex('createdAt', 'createdAt');
      }
      if (oldVersion < 2) d.createObjectStore('runners', { keyPath: 'id' });
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

export async function listRunners(): Promise<Runner[]> {
  return (await (await db()).getAll('runners')).sort((a, b) => a.createdAt - b.createdAt);
}

export async function saveRunner(r: Runner): Promise<void> {
  await (await db()).put('runners', r);
}

export async function deleteRunner(id: string): Promise<void> {
  await (await db()).delete('runners', id);
}
