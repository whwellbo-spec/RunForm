// Demux an MP4/MOV File with mp4box.js. Only the moov box is parsed; the
// mdat payload is skipped and sample bytes are read on demand from the File.
import { createFile, DataStream, MP4BoxBuffer, Endianness, type Movie } from 'mp4box';
import { decodeWindow, editListMapping, findSlowmoHints, presentationOrder, rotationFromMatrix } from './clipmath';

export interface ClipInfo {
  file: File;
  trackId: number;
  codec: string;
  /** Codec configuration record (avcC/hvcC/vpcC/av1C payload) for VideoDecoder. */
  description?: Uint8Array;
  codedWidth: number;
  codedHeight: number;
  rotation: 0 | 90 | 180 | 270;
  /** Display size after rotation. */
  width: number;
  height: number;
  timescale: number;
  nSamples: number;
  // Decode-order sample table.
  cts: Float64Array;
  dts: Float64Array;
  dur: Float64Array;
  offset: Float64Array;
  size: Int32Array;
  isSync: Uint8Array;
  /** presOrder[p] = decode index of the p-th frame in presentation order. */
  presOrder: Int32Array;
  /** Presentation time (s) of the p-th frame on the <video> element timeline. */
  presTimeS: Float64Array;
  durationS: number;
  /** Nominal frame rate: samples / track duration. */
  nominalFps: number;
  brands: string[];
  hasAudio: boolean;
  slowmoHints: string[];
}

const CHUNK = 4 * 1024 * 1024;

export async function demux(file: File): Promise<ClipInfo> {
  const mp4 = createFile();
  let info: Movie | undefined;
  let error: unknown;
  mp4.onReady = (i) => { info = i; };
  mp4.onError = (e) => { error = e; };

  let pos = 0;
  while (!info && !error && pos < file.size) {
    const end = Math.min(file.size, pos + CHUNK);
    const ab = await file.slice(pos, end).arrayBuffer();
    const next = mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(ab, pos), end === file.size);
    // appendBuffer returns where it wants the next bytes, skipping mdat payloads.
    pos = typeof next === 'number' && next > pos ? next : end;
  }
  if (!info) {
    mp4.flush();
  }
  if (error) throw new Error(`MP4 parse error: ${String(error)}`);
  if (!info) throw new Error('No moov box found: not a readable MP4/MOV file.');

  const vt = info.videoTracks[0];
  if (!vt) throw new Error('No video track in file.');
  const trak = mp4.getTrackById(vt.id);
  const samples = trak.samples;
  const n = samples.length;
  if (n < 2) throw new Error('Video track has fewer than 2 samples.');

  const cts = new Float64Array(n), dts = new Float64Array(n), dur = new Float64Array(n), offset = new Float64Array(n);
  const size = new Int32Array(n), isSync = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    cts[i] = s.cts; dts[i] = s.dts; dur[i] = s.duration; offset[i] = s.offset; size[i] = s.size; isSync[i] = s.is_sync ? 1 : 0;
  }
  const presOrder = presentationOrder(cts);
  const { mediaTime, leadInS } = editListMapping(vt.edits, vt.timescale, info.timescale);
  const presTimeS = new Float64Array(n);
  for (let p = 0; p < n; p++) presTimeS[p] = (cts[presOrder[p]] - mediaTime) / vt.timescale + leadInS;

  // Codec configuration record for VideoDecoder.description.
  const entry: any = trak.mdia.minf.stbl.stsd.entries[0];
  let description: Uint8Array | undefined;
  const cfgBox = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C;
  if (cfgBox) {
    const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
    cfgBox.write(stream);
    description = new Uint8Array(stream.buffer as ArrayBuffer, 8); // skip box header
  }

  const codedWidth = vt.video?.width ?? entry.width;
  const codedHeight = vt.video?.height ?? entry.height;
  const rotation = rotationFromMatrix(vt.matrix);
  const swap = rotation === 90 || rotation === 270;

  // Scan the moov box bytes for slow-motion metadata hints.
  let slowmoHints: string[] = [];
  const moov: any = (mp4 as any).moov;
  if (moov && typeof moov.start === 'number' && moov.size > 0 && moov.size < 64 * 1024 * 1024) {
    const bytes = new Uint8Array(await file.slice(moov.start, moov.start + moov.size).arrayBuffer());
    slowmoHints = findSlowmoHints(bytes);
  }

  const durationS = vt.samples_duration / vt.timescale;
  return {
    file, trackId: vt.id, codec: vt.codec, description,
    codedWidth, codedHeight, rotation,
    width: swap ? codedHeight : codedWidth,
    height: swap ? codedWidth : codedHeight,
    timescale: vt.timescale, nSamples: n,
    cts, dts, dur, offset, size, isSync, presOrder, presTimeS,
    durationS,
    nominalFps: n / durationS,
    brands: info.brands,
    hasAudio: info.audioTracks.length > 0,
    slowmoHints,
  };
}

/** Decode-order range to feed for a presentation window. */
export function clipDecodeWindow(c: ClipInfo, presStart: number, presEnd: number) {
  return decodeWindow(c.presOrder, c.isSync, presStart, presEnd);
}

/**
 * Reads sample payloads from the File in large sequential blocks, so feeding
 * thousands of samples does not issue thousands of tiny reads.
 */
export class SampleReader {
  private blockStart = 0;
  private block: Uint8Array | null = null;
  constructor(private file: File, private blockSize = 8 * 1024 * 1024) {}

  async read(offset: number, size: number): Promise<Uint8Array> {
    if (!this.block || offset < this.blockStart || offset + size > this.blockStart + this.block.length) {
      const start = offset;
      const end = Math.min(this.file.size, offset + Math.max(this.blockSize, size));
      this.block = new Uint8Array(await this.file.slice(start, end).arrayBuffer());
      this.blockStart = start;
    }
    const o = offset - this.blockStart;
    return this.block.slice(o, o + size);
  }
}
