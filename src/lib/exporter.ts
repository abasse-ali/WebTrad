import JSZip from 'jszip';
import { canvasToBlob, context2d, createCanvas } from './image';
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

/** Renders the translated page into an image file. */
export async function renderPage(page: Page, target: string, type = 'image/jpeg'): Promise<Blob> {
  await fontsReady();
  const bitmap = await createImageBitmap(page.blob);
  const canvas = createCanvas(bitmap.width, bitmap.height);
  const ctx = context2d(canvas);
  ctx.drawImage(bitmap, 0, 0);
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

/** Zips every translated page (CBZ-compatible). */
export async function exportChapter(
  chapter: Chapter,
  pages: Page[],
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const zip = new JSZip();
  const digits = String(pages.length).length;
  for (const [i, page] of pages.entries()) {
    const blob = await renderPage(page, chapter.targetLang);
    zip.file(`${String(i + 1).padStart(Math.max(3, digits), '0')}.jpg`, blob);
    onProgress?.(i + 1, pages.length);
  }
  const out = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  downloadBlob(out, `${safeName(chapter.title)} [${chapter.targetLang}].cbz`);
}
