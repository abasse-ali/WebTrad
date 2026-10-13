import type { Pixels } from './imageproc';
import type { Box } from './text';

export async function loadBitmap(blob: Blob): Promise<ImageBitmap> {
  return createImageBitmap(blob);
}

export function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

export function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D unavailable');
  return ctx;
}

/** Draws (part of) a bitmap at `scale` and returns its RGBA pixels. */
export function bitmapPixels(bitmap: ImageBitmap, scale = 1, crop?: Box): Pixels {
  const sx = crop?.x ?? 0;
  const sy = crop?.y ?? 0;
  const sw = crop?.w ?? bitmap.width;
  const sh = crop?.h ?? bitmap.height;
  const canvas = createCanvas(sw * scale, sh * scale);
  const ctx = context2d(canvas);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: img.data, width: img.width, height: img.height };
}

export function pixelsToCanvas(px: Pixels): HTMLCanvasElement {
  const canvas = createCanvas(px.width, px.height);
  context2d(canvas).putImageData(new ImageData(new Uint8ClampedArray(px.data), px.width, px.height), 0, 0);
  return canvas;
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/jpeg', quality = 0.92): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Image encoding failed'))), type, quality),
  );
}

/** Small cover for the library: top part of the first page. */
export async function makeThumbnail(blob: Blob, width = 240): Promise<string> {
  const bitmap = await loadBitmap(blob);
  const scale = width / bitmap.width;
  const height = Math.min(bitmap.height * scale, width * 1.4);
  const canvas = createCanvas(width, height);
  const ctx = context2d(canvas);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, bitmap.width, height / scale, 0, 0, width, height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.75);
}

export async function imageSize(blob: Blob): Promise<{ width: number; height: number }> {
  const bitmap = await loadBitmap(blob);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}
