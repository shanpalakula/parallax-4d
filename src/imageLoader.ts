import heic2any from 'heic2any';

/**
 * Loads an image file safely, converting HEIC (iPhone photos) to PNG first.
 * Returns a fully loaded HTMLImageElement at native resolution.
 */
export async function loadImageSafe(file: File): Promise<HTMLImageElement> {
  let blob: Blob = file;

  const isHeic =
    file.type === 'image/heic' ||
    file.type === 'image/heif' ||
    file.name.toLowerCase().endsWith('.heic') ||
    file.name.toLowerCase().endsWith('.heif');

  if (isHeic) {
    blob = (await heic2any({ blob: file, toType: 'image/png', quality: 1 })) as Blob;
  }

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(blob);
  });
}

/**
 * Downscales an image to a target max dimension for AI processing.
 * Preserves aspect ratio. Returns a data URL.
 */
export function downscaleImageForAI(
  img: HTMLImageElement,
  maxDim = 512
): string {
  const scale = Math.min(maxDim / img.naturalWidth, maxDim / img.naturalHeight, 1);
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', 0.92);
}
