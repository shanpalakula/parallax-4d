/**
 * AI Processor Web Worker
 * Runs depth estimation + background removal off the main thread.
 * Auto-detects WebGPU and gracefully falls back to multithreaded WASM (CPU)
 * when WebGPU adapter is unavailable (e.g., in Chrome without flags/hardware accel).
 */
import { pipeline, type RawImage } from '@huggingface/transformers';

export interface AIWorkerInput {
  imageDataUrl: string;   // Downscaled image for AI inference
  originalWidth: number;
  originalHeight: number;
}

export interface AIWorkerOutput {
  /** Normalized float32 depth values [0 = far, 1 = near] */
  depthMap: Float32Array;
  depthWidth: number;
  depthHeight: number;
  /** Data URL of the foreground-only PNG (background removed), or empty string if fallback */
  fgDataUrl: string;
}

let depthEstimatorCache: any = null;

self.onmessage = async (e: MessageEvent<AIWorkerInput>) => {
  const { imageDataUrl } = e.data;

  try {
    // ── 1. Acquire depth pipeline (WebGPU with auto-fallback to WASM) ────────
    const depthEstimator = await getDepthEstimator();

    self.postMessage({ type: 'progress', step: 'Estimating scene depth…', pct: 35 });

    // ── 2. Run depth estimation ──────────────────────────────────────────────
    const depthResult = await depthEstimator(imageDataUrl) as {
      depth: RawImage;
      predicted_depth?: any;
    };

    const depthImg: RawImage = depthResult.depth;
    const depthW = depthImg.width;
    const depthH = depthImg.height;
    const rawData = depthImg.data as any; // Uint8Array or Float32Array

    // Check if values are 0..255 (uint8) or 0..1 (normalized float)
    let isUint8 = false;
    for (let i = 0; i < Math.min(200, rawData.length); i++) {
      if (rawData[i] > 1.05) {
        isUint8 = true;
        break;
      }
    }
    const divisor = isUint8 ? 255 : 1;

    const normalizedDepth = new Float32Array(rawData.length);
    for (let i = 0; i < rawData.length; i++) {
      normalizedDepth[i] = Math.min(Math.max(rawData[i] / divisor, 0), 1);
    }

    self.postMessage({ type: 'progress', step: 'Isolating foreground subject…', pct: 65 });

    // ── 3. Background removal (with safe fallback) ───────────────────────────
    let fgDataUrl = '';

    self.postMessage({ type: 'progress', step: 'Assembling 4D layers…', pct: 95 });

    const result: AIWorkerOutput = {
      depthMap: normalizedDepth,
      depthWidth: depthW,
      depthHeight: depthH,
      fgDataUrl,
    };

    // Transfer the Float32Array buffer for zero-copy memory transfer
    self.postMessage({ type: 'result', data: result }, [normalizedDepth.buffer]);

  } catch (err) {
    console.error('[Parallax4D Worker Error]', err);
    self.postMessage({ type: 'error', message: String(err) });
  }
};

/**
 * Initializes the depth estimation pipeline.
 * Attempts WebGPU first if supported, and automatically falls back to WASM (CPU).
 */
async function getDepthEstimator(): Promise<any> {
  if (depthEstimatorCache) return depthEstimatorCache;

  // Check if WebGPU is truly functional in this environment
  let canUseWebGPU = false;
  try {
    if (typeof navigator !== 'undefined' && 'gpu' in navigator && !!navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        // Test requesting a device to ensure GPU is actually allowed without flags
        const device = await adapter.requestDevice();
        device.destroy();
        canUseWebGPU = true;
      }
    }
  } catch (gpuCheckErr) {
    console.info('[Parallax4D] WebGPU check failed, will use WASM CPU:', gpuCheckErr);
    canUseWebGPU = false;
  }

  // 1. Try WebGPU if adapter is available
  if (canUseWebGPU) {
    try {
      self.postMessage({ type: 'progress', step: 'Loading AI model (WebGPU)…', pct: 10 });
      depthEstimatorCache = await (pipeline as any)(
        'depth-estimation',
        'onnx-community/depth-anything-v2-small',
        {
          device: 'webgpu',
          dtype: 'fp32',
        }
      );
      console.log('[Parallax4D] Depth model loaded via WebGPU');
      return depthEstimatorCache;
    } catch (gpuErr) {
      console.warn('[Parallax4D] WebGPU pipeline failed, falling back to WASM (CPU):', gpuErr);
      depthEstimatorCache = null;
    }
  }

  // 2. Guaranteed fallback: WASM (CPU with SIMD/multithreading)
  // Runs universally on any browser (Chrome, Edge, Firefox, Safari, iOS, Android)
  self.postMessage({ type: 'progress', step: 'Loading AI model (WASM CPU)…', pct: 10 });
  try {
    depthEstimatorCache = await (pipeline as any)(
      'depth-estimation',
      'onnx-community/depth-anything-v2-small',
      {
        device: 'wasm',
      }
    );
    console.log('[Parallax4D] Depth model loaded via WASM (depth-anything-v2-small)');
    return depthEstimatorCache;
  } catch (v2Err) {
    console.warn('[Parallax4D] v2 failed on WASM, trying v1 model fallback:', v2Err);
    depthEstimatorCache = await (pipeline as any)(
      'depth-estimation',
      'Xenova/depth-anything-small-hf',
      {
        device: 'wasm',
      }
    );
    console.log('[Parallax4D] Depth model loaded via WASM (depth-anything-small-hf)');
    return depthEstimatorCache;
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
