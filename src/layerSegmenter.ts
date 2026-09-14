import type { AIWorkerOutput } from './workers/aiProcessor.worker';

export const NUM_LAYERS = 5;
const MAX_RENDER_DIM = 2048; // Crisp 2K resolution — prevents VRAM crashes on phone/laptop

export interface SegmentedLayers {
  layers: ImageData[];
  width: number;
  height: number;
}

/**
 * Segments the original image into NUM_LAYERS ImageData objects based on the depth map.
 * Each layer contains pixels at that depth band (others are transparent).
 * The topmost layer optionally uses the BG-removed foreground mask for ultra-crisp subject edges.
 */
export async function segmentToLayers(
  originalImg: HTMLImageElement,
  aiResult: AIWorkerOutput
): Promise<SegmentedLayers> {
  // Cap max render dimensions to 2048 to prevent memory crashes on 48MP/12MP photos
  const scale = Math.min(
    MAX_RENDER_DIM / originalImg.naturalWidth,
    MAX_RENDER_DIM / originalImg.naturalHeight,
    1.0
  );
  const W = Math.round(originalImg.naturalWidth * scale);
  const H = Math.round(originalImg.naturalHeight * scale);

  // Draw original image to get pixel data at render resolution
  const srcCanvas = new OffscreenCanvas(W, H);
  const srcCtx = srcCanvas.getContext('2d')!;
  srcCtx.drawImage(originalImg, 0, 0, W, H);
  const sourcePixels = srcCtx.getImageData(0, 0, W, H);

  // Load the fg mask from dataURL if available
  let fgMask: ImageData | null = null;
  if (aiResult.fgDataUrl) {
    try {
      fgMask = await loadFgMask(aiResult.fgDataUrl, W, H);
    } catch (e) {
      console.warn('[Parallax4D] Could not load foreground mask, using depth map only:', e);
      fgMask = null;
    }
  }

  // Build bilinear-upscaled depth lookup at render resolution
  const depthAtOriginal = bilinearUpsampleDepth(
    aiResult.depthMap,
    aiResult.depthWidth,
    aiResult.depthHeight,
    W,
    H
  );

  const layerDatas: ImageData[] = Array.from({ length: NUM_LAYERS }, () =>
    new ImageData(W, H)
  );

  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const idx = py * W + px;
      const pixelIdx = idx * 4;

      const depth = depthAtOriginal[idx]; // 0 (far) → 1 (near)
      const layerIdx = Math.min(Math.floor(depth * NUM_LAYERS), NUM_LAYERS - 1);

      const layer = layerDatas[layerIdx];
      layer.data[pixelIdx + 0] = sourcePixels.data[pixelIdx + 0];
      layer.data[pixelIdx + 1] = sourcePixels.data[pixelIdx + 1];
      layer.data[pixelIdx + 2] = sourcePixels.data[pixelIdx + 2];
      layer.data[pixelIdx + 3] = 255;
    }
  }

  // If foreground mask is available, apply it to the topmost layer for razor-sharp edges
  if (fgMask) {
    const topLayer = layerDatas[NUM_LAYERS - 1];
    for (let i = 0; i < W * H; i++) {
      const pixelIdx = i * 4;
      if (fgMask.data[pixelIdx + 3] === 0) {
        topLayer.data[pixelIdx + 3] = 0;
      }
    }
  }

  return { layers: layerDatas, width: W, height: H };
}

/**
 * Bilinear upsampling of a depth map from (sw×sh) to (dw×dh).
 * Much higher quality than nearest-neighbour when depth map is 512px vs image is 2048px.
 */
function bilinearUpsampleDepth(
  depthMap: Float32Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number
): Float32Array {
  const out = new Float32Array(dw * dh);
  for (let dy = 0; dy < dh; dy++) {
    for (let dx = 0; dx < dw; dx++) {
      const sx = (dx / dw) * sw;
      const sy = (dy / dh) * sh;
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const x1 = Math.min(x0 + 1, sw - 1);
      const y1 = Math.min(y0 + 1, sh - 1);
      const fx = sx - x0, fy = sy - y0;

      const v00 = depthMap[y0 * sw + x0];
      const v10 = depthMap[y0 * sw + x1];
      const v01 = depthMap[y1 * sw + x0];
      const v11 = depthMap[y1 * sw + x1];

      out[dy * dw + dx] =
        v00 * (1 - fx) * (1 - fy) +
        v10 * fx * (1 - fy) +
        v01 * (1 - fx) * fy +
        v11 * fx * fy;
    }
  }
  return out;
}

async function loadFgMask(
  fgDataUrl: string,
  targetW: number,
  targetH: number
): Promise<ImageData> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = fgDataUrl;
  });
  const canvas = new OffscreenCanvas(targetW, targetH);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, targetW, targetH);
  return ctx.getImageData(0, 0, targetW, targetH);
}
