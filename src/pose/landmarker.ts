// PoseLandmarker setup with bundled model + WASM (never a CDN), GPU delegate
// with CPU fallback.
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';

export type ModelVariant = 'heavy' | 'full';

const base = import.meta.env.BASE_URL;
const assetUrl = (p: string) => new URL(base + p, document.baseURI).href;

export const MODEL_URL: Record<ModelVariant, string> = {
  heavy: 'models/pose_landmarker_heavy.task',
  full: 'models/pose_landmarker_full.task',
};

async function wasmFileset() {
  // Mirrors FilesetResolver.forVisionTasks() but with our own bundled paths.
  const simd = await FilesetResolver.isSimdSupported();
  const name = simd ? 'vision_wasm_internal' : 'vision_wasm_nosimd_internal';
  return {
    wasmLoaderPath: assetUrl(`mediapipe/wasm/${name}.js`),
    wasmBinaryPath: assetUrl(`mediapipe/wasm/${name}.wasm`),
  };
}

export interface Landmarker {
  pose: PoseLandmarker;
  delegate: 'GPU' | 'CPU';
  model: ModelVariant;
  /** Reason the GPU delegate was not used, if any. */
  gpuError?: string;
}

export async function createLandmarker(model: ModelVariant, preferGpu = true): Promise<Landmarker> {
  const fileset = await wasmFileset();
  const make = (delegate: 'GPU' | 'CPU') =>
    PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: assetUrl(MODEL_URL[model]), delegate },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputSegmentationMasks: false,
    });
  let gpuError: string | undefined;
  if (preferGpu) {
    try {
      const pose = await make('GPU');
      return { pose, delegate: 'GPU', model };
    } catch (e) {
      gpuError = String(e);
      console.warn('GPU delegate failed, falling back to CPU', e);
    }
  }
  const pose = await make('CPU');
  return { pose, delegate: 'CPU', model, gpuError };
}
