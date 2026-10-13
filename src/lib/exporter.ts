import JSZip from 'jszip';
import { canvasToBlob, context2d, createCanvas, decodeImage } from './image';
import { drawLayouts, layoutBubble, type BubbleLayout } from './layout';
import { getSettings } from './settings';
import type { Chapter, Page } from './types';

export async function fontsReady(): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return;
  try {
    await Promise.all([document.fonts.load('700 20px "Comic Neue"'), document.fonts.ready]);
  } catch {
    /* fonts are a nicety, never block on them */
  }
}

export function pageLayouts(page: Page, target: string): BubbleLayout[] {
  const s = getSettings();
  return page.bubbles
    .map((b) => layoutBubble(b, page, { font: s.font, uppercase: s.uppercase, target }))
    .filter((l): l is BubbleLayout => l !== null);
}

const MAX_CANVAS_PIXELS = 16_000_000;

/** Renders the translated page into an image file. */
export async function renderPage(page: Page, target: string, type = 'image/jpeg'): Promise<Blob> {
  await fontsReady();
  const bitmap = await decodeImage(page.blob);
  // Safari refuses canvases above ~16.7 million pixels: shrink taller pages.
  const k = Math.min(1, Math.sqrt(MAX_CANVAS_PIXELS / (bitmap.width * bitmap.height)));
  const canvas = createCanvas(bitmap.width * k, bitmap.height * k);
  const ctx = context2d(canvas);
  ctx.scale(k, k);
  ctx.drawImage(bitmap.source, 0, 0);
  bitmap.close();
  drawLayouts(ctx, pageLayouts(page, target));
  const blob = await canvasToBlob(canvas, type, 0.92);
  canvas.width = canvas.height = 0; // free memory early (iOS)
  return blob;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'chapitre';
}

/**
 * Zips every translated page (CBZ-compatible). A page that cannot be
 * rendered is added untranslated instead of failing the whole export;
 * the returned number tells how many pages that concerned.
 */
export async function exportChapter(
  chapter: Chapter,
  pages: Page[],
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  const zip = new JSZip();
  const digits = String(pages.length).length;
  let untranslated = 0;
  for (const [i, page] of pages.entries()) {
    const name = String(i + 1).padStart(Math.max(3, digits), '0');
    try {
      zip.file(`${name}.jpg`, await renderPage(page, chapter.targetLang));
    } catch {
      untranslated++;
      try {
        // Copy the bytes now: an unreadable blob would break the whole archive.
        const bytes = await page.blob.arrayBuffer();
        const ext = page.blob.type.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
        zip.file(`${name}.${ext}`, bytes);
      } catch {
        /* page lost: leave it out */
      }
    }
    onProgress?.(i + 1, pages.length);
  }
  const out = await zip.generateAsync({ type: 'blob', compression: 'STORE', mimeType: 'application/vnd.comicbook+zip' });
  downloadBlob(out, `${safeName(chapter.title)} [${chapter.targetLang}].cbz`);
  return untranslated;
}
