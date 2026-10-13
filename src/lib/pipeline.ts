import { useSyncExternalStore } from 'react';
import { getChapter, getPages, patchChapter, patchPage, uid } from './db';
import { bitmapPixels, context2d, createCanvas, decodeImage, type DecodedImage } from './image';
import { detectBubbles, innerBox, sampleBackground } from './imageproc';
import {
  detectPageLanguage,
  finishLanguageDetection,
  ocrPage,
  setOcrStatusListener,
  type DetectedText,
} from './ocr';
import { LLM_PRESETS, getSettings } from './settings';
import { normaliseCase, type Box } from './text';
import { translateTexts } from './translate';
import { visionTranslate } from './translate/llm';
import { AUTO, normaliseSourceCode, sourceLanguage } from './languages';
import type { Bubble, Chapter, Page } from './types';

// --- job state store ----------------------------------------------------------

export interface JobState {
  chapterId: string;
  running: boolean;
  total: number;
  done: number;
  failed: number;
  pageIndex: number | null;
  phase: 'detect' | 'ocr' | 'translate' | 'download' | 'idle';
  message?: string;
  engine?: string;
}

const jobs = new Map<string, JobState>();
const controllers = new Map<string, AbortController>();
const listeners = new Set<() => void>();
let snapshot = new Map(jobs);

function emit() {
  snapshot = new Map(jobs);
  listeners.forEach((l) => l());
}

function setJob(chapterId: string, patch: Partial<JobState>) {
  const prev = jobs.get(chapterId) ?? {
    chapterId,
    running: false,
    total: 0,
    done: 0,
    failed: 0,
    pageIndex: null,
    phase: 'idle' as const,
  };
  jobs.set(chapterId, { ...prev, ...patch });
  emit();
}

export function useJobs(): Map<string, JobState> {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
  );
}

export function useJob(chapterId: string | undefined): JobState | undefined {
  const all = useJobs();
  return chapterId ? all.get(chapterId) : undefined;
}

// --- page processing ----------------------------------------------------------

function toBubble(d: DetectedText, translation: string): Bubble {
  return {
    id: uid(),
    x: d.box.x,
    y: d.box.y,
    w: d.box.w,
    h: d.box.h,
    area: d.area,
    original: d.text,
    translation,
    confidence: Math.round(d.confidence),
    vertical: d.vertical,
    fontSize: d.fontSize,
    fill: d.fill,
    outline: d.outline || undefined,
  };
}

function prepareForTranslation(text: string, source: string): string {
  return sourceLanguage(source).noSpaces ? text : normaliseCase(text);
}

/** Translates the given bubbles, keeping the ones the user edited by hand. */
export async function translateBubbles(
  bubbles: Bubble[],
  chapter: Chapter,
  signal?: AbortSignal,
): Promise<{ bubbles: Bubble[]; engine: string }> {
  const todo = bubbles.filter((b) => !b.edited && b.original.trim());
  if (todo.length === 0) return { bubbles, engine: 'none' };
  const { translations, engine } = await translateTexts(
    todo.map((b) => prepareForTranslation(b.original, chapter.sourceLang)),
    chapter.sourceLang,
    chapter.targetLang,
    signal,
  );
  const byId = new Map(todo.map((b, i) => [b.id, translations[i]]));
  return { bubbles: bubbles.map((b) => (byId.has(b.id) ? { ...b, translation: byId.get(b.id) ?? '' } : b)), engine };
}

const VISION_MAX_SIDE = 1536;

/** AI vision mode: one request per slice of the page reads and translates. */
async function visionPage(bitmap: DecodedImage, chapter: Chapter, signal: AbortSignal): Promise<Bubble[]> {
  const W = bitmap.width;
  const H = bitmap.height;
  const sliceH = Math.min(H, Math.round(W * 1.6));
  const overlap = sliceH < H ? Math.round(sliceH * 0.12) : 0;
  const scale = Math.min(1, Math.sqrt(12_000_000 / (W * H)));
  const px = bitmapPixels(bitmap, scale);
  const regions = detectBubbles(px);
  const bubbles: Bubble[] = [];
  for (let top = 0; top < H; top += sliceH - overlap) {
    const h = Math.min(sliceH, H - top);
    const k = Math.min(1, VISION_MAX_SIDE / Math.max(W, h));
    const canvas = createCanvas(W * k, h * k);
    const c = context2d(canvas);
    c.imageSmoothingQuality = 'high';
    c.drawImage(bitmap.source, 0, top, W, h, 0, 0, canvas.width, canvas.height);
    const result = await visionTranslate(canvas.toDataURL('image/jpeg', 0.88), chapter.sourceLang, chapter.targetLang, signal);
    const found = result.bubbles;
    const detected = normaliseSourceCode(result.sourceLanguage);
    if (chapter.sourceLang === AUTO && detected) {
      // The model told us the language: remember it for edits and retranslations.
      chapter.sourceLang = detected;
      chapter.autoSource = true;
      await patchChapter(chapter.id, { sourceLang: detected, autoSource: true });
    }
    const ownTop = top === 0 ? 0 : top + overlap / 2;
    const ownBottom = top + h >= H ? H : top + h - overlap / 2;
    for (const f of found) {
      const [y0, x0, y1, x1] = f.box;
      const box: Box = { x: (x0 / 1000) * W, y: top + (y0 / 1000) * h, w: ((x1 - x0) / 1000) * W, h: ((y1 - y0) / 1000) * h };
      const cy = box.y + box.h / 2;
      if (cy < ownTop || cy >= ownBottom) continue;
      const cx = box.x + box.w / 2;
      const region = regions.find(
        (r) => cx * scale >= r.x && cx * scale <= r.x + r.w && cy * scale >= r.y && cy * scale <= r.y + r.h,
      );
      let area: Box | undefined;
      if (region) {
        const inner = innerBox(region, cx * scale, cy * scale, box.h * scale);
        if (inner.w > 0) area = { x: inner.x / scale, y: inner.y / scale, w: inner.w / scale, h: inner.h / scale };
        if (area && area.w * area.h < box.w * box.h * 0.6) area = undefined;
      }
      const bg = sampleBackground(px, { x: box.x * scale, y: box.y * scale, w: box.w * scale, h: box.h * scale });
      const vertical = box.h > box.w * 1.6;
      const lines = Math.max(1, f.text.split('\n').length);
      bubbles.push({
        id: uid(),
        ...box,
        area,
        original: f.text,
        translation: f.translation,
        vertical,
        fontSize: Math.max(10, Math.min(60, (vertical ? box.w : box.h) / lines)),
        fill: bg.fill,
        outline: bg.uniformity < 0.6 || undefined,
      });
    }
    if (top + h >= H) break;
  }
  return bubbles;
}

function visionEnabled(): boolean {
  const settings = getSettings();
  const preset = LLM_PRESETS.find((p) => p.id === settings.llm.preset);
  // Without a key for a hosted provider the AI mode cannot work: use local OCR.
  return (
    settings.ocrEngine === 'vision' &&
    settings.llm.baseUrl.trim() !== '' &&
    (settings.llm.apiKey.trim() !== '' || !preset?.needsKey)
  );
}

/** Pages read to find the language when the first ones have no text (cover, credits…). */
const DETECTION_PAGES = 6;
const DETECTION_FALLBACK = 'ko';

/** Finds the language of a chapter from its first pages with text. */
async function detectChapterLanguage(chapter: Chapter, pages: Page[], signal: AbortSignal): Promise<string> {
  setJob(chapter.id, { phase: 'detect', pageIndex: null, message: undefined });
  try {
    for (const page of pages.slice(0, DETECTION_PAGES)) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const bitmap = await decodeImage(page.blob);
      try {
        const code = await detectPageLanguage(bitmap);
        if (code) return code;
      } finally {
        bitmap.close();
      }
    }
    return DETECTION_FALLBACK;
  } finally {
    await finishLanguageDetection();
  }
}

async function processPage(page: Page, chapter: Chapter, signal: AbortSignal): Promise<string | undefined> {
  const settings = getSettings();
  const useVision = visionEnabled();
  setJob(chapter.id, { pageIndex: page.index, phase: 'ocr' });
  await patchPage(page.id, { status: 'ocr', error: undefined });
  const bitmap = await decodeImage(page.blob);
  try {
    if (useVision) {
      const bubbles = await visionPage(bitmap, chapter, signal);
      await patchPage(page.id, { bubbles, status: 'done' });
      return 'llm';
    }
    const detected = await ocrPage(bitmap, chapter.sourceLang, { minConfidence: settings.minConfidence, signal });
    let bubbles = detected.map((d) => toBubble(d, ''));
    // Save the OCR result first: if translation fails the work is not lost.
    await patchPage(page.id, { bubbles, status: 'translating' });
    setJob(chapter.id, { phase: 'translate' });
    const result = await translateBubbles(bubbles, chapter, signal);
    bubbles = result.bubbles;
    await patchPage(page.id, { bubbles, status: 'done' });
    return result.engine;
  } finally {
    bitmap.close();
  }
}

export async function refreshStats(chapterId: string): Promise<void> {
  const pages = await getPages(chapterId);
  await patchChapter(
    chapterId,
    {
      stats: {
        total: pages.length,
        done: pages.filter((p) => p.status === 'done').length,
        errors: pages.filter((p) => p.status === 'error').length,
      },
    },
    false,
  );
}

export interface StartOptions {
  /** Pages to (re)process. Default: every page not done yet. */
  pageIds?: string[];
  /** Only translate again, keep the detected bubbles. */
  translateOnly?: boolean;
}

export function isRunning(chapterId: string): boolean {
  return jobs.get(chapterId)?.running ?? false;
}

export function cancelChapter(chapterId: string): void {
  controllers.get(chapterId)?.abort();
}

const runs = new Map<string, Promise<void>>();

/** Cancels the job of a chapter and resolves once it has really stopped. */
export async function stopChapter(chapterId: string): Promise<void> {
  cancelChapter(chapterId);
  await runs.get(chapterId);
}

let ocrQueue: Promise<unknown> = Promise.resolve();

/** Processes a chapter in the background (one chapter at a time). */
export function startChapter(chapterId: string, opts: StartOptions = {}): Promise<void> {
  if (isRunning(chapterId)) return Promise.resolve();
  const controller = new AbortController();
  controllers.set(chapterId, controller);
  setJob(chapterId, { running: true, done: 0, failed: 0, total: 0, phase: 'idle', message: undefined, pageIndex: null });
  const run = ocrQueue.then(async () => {
    const chapter = await getChapter(chapterId);
    if (!chapter) return;
    const pages = await getPages(chapterId);
    const todo = pages.filter((p) => (opts.pageIds ? opts.pageIds.includes(p.id) : p.status !== 'done'));
    setJob(chapterId, { total: todo.length });
    setOcrStatusListener((message, progress) =>
      setJob(chapterId, {
        phase: 'download',
        message: progress !== undefined ? `${message} ${Math.round(progress * 100)}%` : message,
      }),
    );
    // Local OCR needs the language up front; the AI vision mode reports it itself.
    if (chapter.sourceLang === AUTO && todo.length > 0 && !visionEnabled() && !opts.translateOnly) {
      const code = await detectChapterLanguage(chapter, pages, controller.signal);
      chapter.sourceLang = code;
      chapter.autoSource = true;
      await patchChapter(chapterId, { sourceLang: code, autoSource: true });
    }
    let done = 0;
    let failed = 0;
    for (const page of todo) {
      if (controller.signal.aborted) break;
      try {
        let engine: string | undefined;
        if (opts.translateOnly && page.bubbles.length > 0) {
          setJob(chapterId, { pageIndex: page.index, phase: 'translate' });
          await patchPage(page.id, { status: 'translating', error: undefined });
          const result = await translateBubbles(page.bubbles, chapter, controller.signal);
          engine = result.engine;
          await patchPage(page.id, { bubbles: result.bubbles, status: 'done' });
        } else {
          engine = await processPage(page, chapter, controller.signal);
        }
        done++;
        setJob(chapterId, { done, engine, message: undefined });
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          await patchPage(page.id, { status: page.bubbles.length ? 'done' : 'pending' });
          break;
        }
        failed++;
        const message = (err as Error).message || String(err);
        await patchPage(page.id, { status: 'error', error: message });
        setJob(chapterId, { failed, message });
      }
      await refreshStats(chapterId);
    }
    await refreshStats(chapterId);
    setOcrStatusListener(null);
    setJob(chapterId, { running: false, phase: 'idle', pageIndex: null });
    controllers.delete(chapterId);
  });
  ocrQueue = run.catch(() => undefined);
  const settled = run.catch((err) => {
    setOcrStatusListener(null);
    controllers.delete(chapterId);
    setJob(chapterId, { running: false, phase: 'idle', message: (err as Error).message });
  });
  runs.set(chapterId, settled);
  void settled.then(() => runs.get(chapterId) === settled && runs.delete(chapterId));
  return settled;
}
