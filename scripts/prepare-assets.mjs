// Copies the MediaPipe WASM fileset out of node_modules and downloads the pose
// models into public/, so both are served from our own origin (and precached by
// the service worker). Nothing is loaded from a CDN at runtime.
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const wasmSrc = join(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const wasmDst = join(root, 'public/mediapipe/wasm');
mkdirSync(wasmDst, { recursive: true });
// SIMD build + no-SIMD fallback. The ES-module variant is not used.
for (const f of [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
]) {
  copyFileSync(join(wasmSrc, f), join(wasmDst, f));
}

// Pinned model versions (float16, version 1).
const MODELS = {
  'pose_landmarker_heavy.task':
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task',
  'pose_landmarker_full.task':
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
};
const modelDst = join(root, 'public/models');
mkdirSync(modelDst, { recursive: true });
for (const [name, url] of Object.entries(MODELS)) {
  const out = join(modelDst, name);
  if (existsSync(out) && statSync(out).size > 1_000_000) continue;
  console.log(`Downloading ${name} ...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);
  writeFileSync(out, Buffer.from(await res.arrayBuffer()));
}
console.log('MediaPipe assets ready.');
