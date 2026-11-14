import JSZip from 'jszip';
import { canvasToBlob, context2d, createCanvas, decodeImage } from './image';
import { drawLayouts, layoutBubble, type BubbleLayout } from './layout';
import { isNativeApp, shareFile, shareFiles } from './native';
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
    .map((b) => layoutBubble(b, page, { font: s.font, letterCase: s.letterCase, target }))
    .filter((l): l is BubbleLayout => l !== null);
}

const MAX_CANVAS_PIXELS = 16_000_000;

function release(canvas: HTMLCanvasElement): void {
  canvas.width = canvas.height = 0; // free memory early (iOS)
}

/** What an exported page shows: the translation, or the original beside it. */
export type ExportMode = 'translated' | 'compare';
export type ExportFormat = 'cbz' | 'images';

/** Gap between the original and the translation in "compare" pages, in page pixels. */
const COMPARE_GAP = 16;
const COMPARE_BACKGROUND = '#111016';

/**
 * Draws the page on a canvas (kept below Safari's size limit): translated,
 * or in "compare" mode the original on the left and the translation on the
 * right, as the reader's Compare view shows them.
 */
async function renderCanvas(page: Page, target: string, mode: ExportMode = 'translated'): Promise<HTMLCanvasElement> {
  await fontsReady();
  const bitmap = await decodeImage(page.blob);
  const compare = mode === 'compare';
  const fullWidth = compare ? bitmap.width * 2 + COMPARE_GAP : bitmap.width;
  // Safari refuses canvases above ~16.7 million pixels: shrink taller pages.
  const k = Math.min(1, Math.sqrt(MAX_CANVAS_PIXELS / (fullWidth * bitmap.height)));
  const canvas = createCanvas(fullWidth * k, bitmap.height * k);
  const ctx = context2d(canvas);
  ctx.scale(k, k);
  if (compare) {
    ctx.fillStyle = COMPARE_BACKGROUND;
    ctx.fillRect(0, 0, fullWidth, bitmap.height);
    ctx.drawImage(bitmap.source, 0, 0);
    // The translation is drawn on the right half.
    ctx.translate(bitmap.width + COMPARE_GAP, 0);
  }
  ctx.drawImage(bitmap.source, 0, 0);
  bitmap.close();
  const layouts = pageLayouts(page, target);
  const patches = new Map<string, CanvasImageSource>();
  await Promise.all(
    layouts.map(async (l) => {
      if (!l.patch || patches.has(l.patch)) return;
      const img = new Image();
      img.src = l.patch;
      // A patch that does not decode falls back to the flat fill.
      await img.decode().then(() => patches.set(l.patch!, img), () => undefined);
    }),
  );
  drawLayouts(ctx, layouts, patches);
  return canvas;
}

/** Renders the page into an image file (full quality). */
export async function renderPage(page: Page, target: string, mode: ExportMode = 'translated', type = 'image/jpeg'): Promise<Blob> {
  const canvas = await renderCanvas(page, target, mode);
  try {
    return await canvasToBlob(canvas, type, 0.92);
  } finally {
    release(canvas);
  }
}

function resized(canvas: HTMLCanvasElement, scale: number): HTMLCanvasElement {
  const out = createCanvas(canvas.width * scale, canvas.height * scale);
  const ctx = context2d(out);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
  return out;
}

const QUALITIES = [0.9, 0.8, 0.7];
const MIN_SCALE = 0.3;

/**
 * Encodes a canvas as JPEG in at most `budget` bytes: the JPEG quality is
 * lowered first (barely visible), then the resolution if still needed.
 */
export async function encodeWithin(canvas: HTMLCanvasElement, budget: number): Promise<Blob> {
  let best: Blob | null = null;
  const keep = (b: Blob) => {
    if (!best || b.size < best.size) best = b;
    return b.size <= budget;
  };
  for (const q of QUALITIES) {
    const blob = await canvasToBlob(canvas, 'image/jpeg', q);
    if (keep(blob)) return blob;
  }
  let scale = 1;
  let quality = QUALITIES[QUALITIES.length - 1];
  for (let attempt = 0; attempt < 6; attempt++) {
    const ratio = budget / best!.size;
    if (scale <= MIN_SCALE) {
      if (quality <= 0.5) break;
      quality = 0.5;
    } else {
      scale = Math.max(MIN_SCALE, scale * Math.sqrt(ratio) * 0.95);
    }
    const small = resized(canvas, scale);
    const blob = await canvasToBlob(small, 'image/jpeg', quality);
    release(small);
    if (keep(blob)) return blob;
  }
  return best!;
}

export function downloadBlob(blob: Blob, filename: string): void {
  if (isNativeApp()) {
    // No downloads in an iPhone app: the share sheet saves or sends the file.
    void shareFile(blob, filename).catch(() => undefined);
    return;
  }
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

export interface ExportResult {
  /** Pages added without translation because they could not be drawn. */
  untranslated: number;
  /** Size of the archive in bytes. */
  size: number;
}

/** Approximate ZIP bookkeeping per file plus the central directory. */
const ZIP_OVERHEAD_PER_FILE = 256;

async function buildArchive(
  chapter: Chapter,
  pages: Page[],
  maxBytes: number,
  mode: ExportMode,
  onProgress?: (done: number, total: number) => void,
): Promise<{ zip: Blob; untranslated: number }> {
  const zip = new JSZip();
  const digits = String(pages.length).length;
  const areas = pages.map((p) => p.width * p.height);
  // Budget shared out by page area; what a page does not use goes to the next ones.
  let remainingBytes = maxBytes - ZIP_OVERHEAD_PER_FILE * pages.length - 16_384;
  let remainingArea = areas.reduce((a, b) => a + b, 0);
  let untranslated = 0;
  for (const [i, page] of pages.entries()) {
    const name = String(i + 1).padStart(Math.max(3, digits), '0');
    const budget = maxBytes > 0 ? Math.max(20_000, (remainingBytes * areas[i]) / remainingArea) : Infinity;
    let size = 0;
    try {
      const canvas = await renderCanvas(page, chapter.targetLang, mode);
      try {
        const blob = Number.isFinite(budget) ? await encodeWithin(canvas, budget) : await canvasToBlob(canvas, 'image/jpeg', 0.92);
        zip.file(`${name}.jpg`, blob);
        size = blob.size;
      } finally {
        release(canvas);
      }
    } catch {
      untranslated++;
      try {
        // Copy the bytes now: an unreadable blob would break the whole archive.
        const bytes = await page.blob.arrayBuffer();
        const ext = page.blob.type.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
        zip.file(`${name}.${ext}`, bytes);
        size = bytes.byteLength;
      } catch {
        /* page lost: leave it out */
      }
    }
    remainingBytes -= size;
    remainingArea -= areas[i];
    onProgress?.(i + 1, pages.length);
  }
  const out = await zip.generateAsync({ type: 'blob', compression: 'STORE', mimeType: 'application/vnd.comicbook+zip' });
  return { zip: out, untranslated };
}

export interface ExportOptions {
  mode?: ExportMode;
  format?: ExportFormat;
  onProgress?: (done: number, total: number) => void;
  /** Maximum size of a .cbz in megabytes (0 = no limit). */
  maxMB?: number;
}

/**
 * Exports every page of the chapter, translated or side by side with the
 * original. As a .cbz (within `maxMB`, a page that cannot be rendered is
 * added untranslated instead of failing the whole export), or as separate
 * images: the iPhone app hands them to the share sheet ("Save N images"),
 * the web version downloads them in a .zip.
 */
export async function exportChapter(chapter: Chapter, pages: Page[], options: ExportOptions = {}): Promise<ExportResult> {
  const { mode = 'translated', format = 'cbz', onProgress, maxMB = getSettings().exportMaxMB } = options;
  const base = `${safeName(chapter.title)} [${chapter.targetLang}]${mode === 'compare' ? ' (comparer)' : ''}`;
  if (format === 'images') return exportImages(chapter, pages, mode, base, onProgress);
  // Decimal megabytes, as phones and file managers count them, with a small margin.
  const limit = maxMB > 0 ? maxMB * 1_000_000 * 0.98 : 0;
  let result = await buildArchive(chapter, pages, limit, mode, onProgress);
  // Pages that could not be shrunk (or added as originals) may overshoot: retry tighter.
  for (let pass = 1; limit > 0 && result.zip.size > limit && pass <= 2; pass++) {
    result = await buildArchive(chapter, pages, limit * Math.pow(0.85, pass), mode, onProgress);
  }
  downloadBlob(result.zip, `${base}.cbz`);
  return { untranslated: result.untranslated, size: result.zip.size };
}

async function exportImages(
  chapter: Chapter,
  pages: Page[],
  mode: ExportMode,
  base: string,
  onProgress?: (done: number, total: number) => void,
): Promise<ExportResult> {
  const digits = Math.max(3, String(pages.length).length);
  const files: { blob: Blob; name: string }[] = [];
  let untranslated = 0;
  for (const [i, page] of pages.entries()) {
    const name = `${base} - ${String(i + 1).padStart(digits, '0')}.jpg`;
    try {
      files.push({ blob: await renderPage(page, chapter.targetLang, mode), name });
    } catch {
      untranslated++;
      try {
        files.push({ blob: new Blob([await page.blob.arrayBuffer()], { type: page.blob.type || 'image/jpeg' }), name });
      } catch {
        /* page lost: left out */
      }
    }
    onProgress?.(i + 1, pages.length);
  }
  const size = files.reduce((n, f) => n + f.blob.size, 0);
  if (isNativeApp()) {
    await shareFiles(files);
  } else {
    // Several separate downloads are blocked by browsers: one .zip holds them.
    const zip = new JSZip();
    files.forEach((f) => zip.file(f.name, f.blob));
    downloadBlob(await zip.generateAsync({ type: 'blob', compression: 'STORE' }), `${base}.zip`);
  }
  return { untranslated, size };
}
