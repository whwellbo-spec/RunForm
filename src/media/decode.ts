// Deterministic frame extraction with WebCodecs. Every sample in the decode
// window is fed; every output frame in the presentation window is yielded once,
// in presentation order. The caller must close() each yielded frame.
import { clipDecodeWindow, SampleReader, type ClipInfo } from './demux';

export interface DecodedFrame {
  frame: VideoFrame;
  /** Presentation index in the clip. */
  presIndex: number;
}

export function decoderConfig(c: ClipInfo): VideoDecoderConfig {
  return {
    codec: c.codec,
    codedWidth: c.codedWidth,
    codedHeight: c.codedHeight,
    description: c.description,
    optimizeForLatency: true,
  };
}

export async function webCodecsSupport(c: ClipInfo): Promise<{ supported: boolean; reason: string }> {
  if (typeof VideoDecoder === 'undefined') return { supported: false, reason: 'WebCodecs VideoDecoder not available' };
  try {
    const r = await VideoDecoder.isConfigSupported(decoderConfig(c));
    return { supported: !!r.supported, reason: r.supported ? `VideoDecoder supports ${c.codec}` : `VideoDecoder does not support ${c.codec}` };
  } catch (e) {
    return { supported: false, reason: `isConfigSupported threw: ${String(e)}` };
  }
}

export interface DecodeOptions {
  /** Max frames decoded but not yet consumed. Keeps memory bounded. */
  maxQueuedFrames?: number;
  /** Max chunks queued inside the decoder. */
  maxDecodeQueue?: number;
  signal?: AbortSignal;
}

/**
 * Yield frames for presentation indices [presStart, presEnd].
 * Throws if any frame in the window is missing at the end (never skips silently).
 */
export async function* decodeFrames(c: ClipInfo, presStart: number, presEnd: number, opts: DecodeOptions = {}): AsyncGenerator<DecodedFrame> {
  const maxQueued = opts.maxQueuedFrames ?? 3;
  const maxDecodeQueue = opts.maxDecodeQueue ?? 4;
  const { feedStart, feedEnd } = clipDecodeWindow(c, presStart, presEnd);

  // Timestamp (µs, from raw cts) -> presentation index.
  const tsToPres = new Map<number, number>();
  const presOfDecode = new Int32Array(c.nSamples);
  for (let p = 0; p < c.nSamples; p++) presOfDecode[c.presOrder[p]] = p;
  const tsOf = (d: number) => Math.round((c.cts[d] * 1e6) / c.timescale);
  for (let d = feedStart; d <= feedEnd; d++) tsToPres.set(tsOf(d), presOfDecode[d]);

  const queue: DecodedFrame[] = [];
  let decodeError: unknown = null;
  let wake: (() => void) | null = null;
  const notify = () => { const w = wake; wake = null; w?.(); };

  const decoder = new VideoDecoder({
    output: (frame) => {
      const p = tsToPres.get(frame.timestamp);
      if (p === undefined || p < presStart || p > presEnd) { frame.close(); return; }
      queue.push({ frame, presIndex: p });
      notify();
    },
    error: (e) => { decodeError = e; notify(); },
  });
  decoder.configure(decoderConfig(c));
  decoder.addEventListener?.('dequeue', notify);

  const reader = new SampleReader(c.file);
  const seen = new Uint8Array(presEnd - presStart + 1);
  let next = feedStart;
  let flushing: Promise<void> | null = null;
  let flushed = false;
  const waitForEvent = () => new Promise<void>((r) => { wake = r; setTimeout(notify, 50); });

  try {
    while (true) {
      if (decodeError) throw decodeError;
      if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      if (queue.length) {
        // Frames are emitted in presentation order by the decoder.
        const item = queue.shift()!;
        seen[item.presIndex - presStart] = 1;
        yield item;
        continue;
      }
      // Feed more input while the pipeline is shallow.
      if (next <= feedEnd) {
        if (decoder.decodeQueueSize >= maxDecodeQueue || queue.length >= maxQueued) { await waitForEvent(); continue; }
        const data = await reader.read(c.offset[next], c.size[next]);
        decoder.decode(new EncodedVideoChunk({
          type: c.isSync[next] ? 'key' : 'delta',
          timestamp: tsOf(next),
          duration: Math.round((c.dur[next] * 1e6) / c.timescale),
          data,
        }));
        next++;
        continue;
      }
      if (!flushing) {
        flushing = decoder.flush().then(() => { flushed = true; notify(); }, (e) => { decodeError = e; notify(); });
        continue;
      }
      if (flushed && queue.length === 0) break;
      await waitForEvent();
    }
  } finally {
    for (const q of queue) q.frame.close();
    queue.length = 0;
    if (decoder.state !== 'closed') decoder.close();
  }
  const missing: number[] = [];
  for (let i = 0; i < seen.length; i++) if (!seen[i]) missing.push(presStart + i);
  if (missing.length) {
    throw new Error(`Decoder did not output ${missing.length} frame(s) in the window (first: ${missing.slice(0, 5).join(', ')})`);
  }
}
