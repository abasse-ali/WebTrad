import { useSyncExternalStore } from 'react';
import { getChapter, getPages, patchChapter, patchPage, resetStalePages, uid } from './db';
import { bitmapPixels, context2d, createCanvas, decodeImage, pixelsToCanvas, type DecodedImage } from './image';
import { cleanBubble, detectAllBubbles, innerBox, maskedCrop, regionFill } from './imageproc';
import { otherTabIsProcessing, setProcessing } from './keepalive';
import {
  detectPageLanguage,
  lookOfText,
  finishLanguageDetection,
  ocrPage,
  setOcrStatusListener,
  type DetectedText,
} from './ocr';
import { logError, logInfo, logWarn, since } from './log';
import { LLM_PRESETS, getSettings } from './settings';
import { normaliseCase, type Box } from './text';
import { translateTexts } from './translate';
import { visionTranslate } from './translate/llm';
import { TranslateError } from './translate/types';
import { isSoundEffect } from './text';
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
  setProcessing([...jobs.values()].some((j) => j.running));
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
    color: d.color,
    rotation: d.rotation,
    align: d.align,
    patch: d.patch,
    patchBox: d.patchBox,
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

/**
 * Free AI tiers time out or answer "busy" (429, 5xx) now and then: a slice
 * is tried again twice, after a pause, before the page is marked in error.
 */
async function withRetries<T>(run: () => Promise<T>, signal: AbortSignal, waits = [4000, 15000]): Promise<T> {
  let limited = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      const retryable = !(err instanceof TranslateError) || err.retryable;
      // Rate limits (429) only mean "wait": the request waits for the window
      // to reset (see llm.ts) and is tried again, up to 8 times.
      const rateLimited = /HTTP 429/.test((err as Error).message);
      if (rateLimited) limited++;
      const giveUp = rateLimited ? limited > 8 : attempt - limited >= waits.length;
      if ((err as Error).name === 'AbortError' || !retryable || giveUp) throw err;
      const wait = rateLimited ? 0 : waits[attempt - limited];
      if (!rateLimited) logWarn('ia', `Nouvel essai dans ${wait / 1000} s : ${(err as Error).message.slice(0, 120)}`, { essai: attempt + 2 });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, wait);
        signal.addEventListener('abort', () => (clearTimeout(timer), reject(new DOMException('Aborted', 'AbortError'))), { once: true });
      });
    }
  }
}

/** AI vision mode: one request per slice of the page reads and translates. */
/** Text that says the same once letters, case and punctuation are compared ("HUFF" → "HUFF!"). */
function sameText(a: string, b: string): boolean {
  const norm = (t: string) => t.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  return norm(a) !== '' && norm(a) === norm(b);
}

/** Slices of the page read by the AI at the same time (free tiers allow ~40 requests a minute). */
const VISION_PARALLEL = 3;

/** AI vision mode: the page is cut in slices, each read and translated by one request. */
async function visionPage(bitmap: DecodedImage, chapter: Chapter, signal: AbortSignal): Promise<Bubble[]> {
  const W = bitmap.width;
  const H = bitmap.height;
  // Tall slices: a webtoon page costs fewer requests (vision models read tall images well).
  const sliceH = Math.min(H, Math.round(W * 2.2));
  const overlap = sliceH < H ? Math.round(sliceH * 0.12) : 0;
  const scale = Math.min(1, Math.sqrt(12_000_000 / (W * H)));
  const px = bitmapPixels(bitmap, scale);
  const regions = detectAllBubbles(px);

  const slices: { top: number; h: number; image: string; width: number; height: number }[] = [];
  for (let top = 0; top < H; top += sliceH - overlap) {
    const h = Math.min(sliceH, H - top);
    const k = Math.min(1, VISION_MAX_SIDE / Math.max(W, h));
    const canvas = createCanvas(W * k, h * k);
    const c = context2d(canvas);
    c.imageSmoothingQuality = 'high';
    c.drawImage(bitmap.source, 0, top, W, h, 0, 0, canvas.width, canvas.height);
    slices.push({ top, h, image: canvas.toDataURL('image/jpeg', 0.88), width: canvas.width, height: canvas.height });
    canvas.width = canvas.height = 0;
    if (top + h >= H) break;
  }

  // A few slices at once: the page takes about as long as its slowest slice.
  const results: Awaited<ReturnType<typeof visionTranslate>>[] = new Array(slices.length);
  let next = 0;
  const worker = async () => {
    while (next < slices.length) {
      const i = next++;
      const slice = slices[i];
      results[i] = await withRetries(
        () => visionTranslate(slice.image, chapter.sourceLang, chapter.targetLang, signal, undefined, { width: slice.width, height: slice.height }),
        signal,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(VISION_PARALLEL, slices.length) }, worker));

  const detected = normaliseSourceCode(results.find((r) => r.sourceLanguage)?.sourceLanguage);
  if (chapter.sourceLang === AUTO && detected) {
    // The model told us the language: remember it for edits and retranslations.
    chapter.sourceLang = detected;
    chapter.autoSource = true;
    await patchChapter(chapter.id, { sourceLang: detected, autoSource: true });
  }

  const bubbles: Bubble[] = [];
  for (const [i, { top, h }] of slices.entries()) {
    const ownTop = top === 0 ? 0 : top + overlap / 2;
    const ownBottom = top + h >= H ? H : top + h - overlap / 2;
    for (const f of results[i].bubbles) {
      // Untranslatable sound effects ("HUFF" → "HUFF"): the drawn lettering stays.
      if (!f.translation.trim() || sameText(f.text, f.translation)) continue;
      const [y0, x0, y1, x1] = f.box;
      const box: Box = { x: (x0 / 1000) * W, y: top + (y0 / 1000) * h, w: ((x1 - x0) / 1000) * W, h: ((y1 - y0) / 1000) * h };
      const cy = box.y + box.h / 2;
      if (cy < ownTop || cy >= ownBottom) continue;
      const cx = box.x + box.w / 2;
      const region = regions.find((r) => cx * scale >= r.x && cx * scale <= r.x + r.w && cy * scale >= r.y && cy * scale <= r.y + r.h);
      // Sound effects drawn on the artwork are not translated, even when the model sends them.
      if (!region && isSoundEffect(f.text)) continue;
      const lines = Math.max(1, f.text.split('\n').length);
      const vertical = box.h > box.w * 1.6;
      const ink = region ? maskedCrop(px, region).ink : null;
      if (region && ink && !vertical) {
        // In a bubble: sized on the real letters, erased within the bubble's shape.
        const inkBox = { x: ink.x / scale, y: ink.y / scale, w: ink.w / scale, h: ink.h / scale };
        const fontSize = Math.max(8, Math.min(60, inkBox.h / (lines * 1.2)));
        const fill = regionFill(px, region);
        const look = lookOfText(px, inkBox, scale, fontSize, true);
        const pad = Math.max(2, fontSize * 0.5) * scale;
        let patch: string | undefined;
        let patchBox: Box | undefined;
        try {
          const cleaned = cleanBubble(px, region, { x: ink.x - pad, y: ink.y - pad, w: ink.w + pad * 2, h: ink.h + pad * 2 }, fill);
          patch = pixelsToCanvas(cleaned.pixels).toDataURL('image/jpeg', 0.92);
          patchBox = { x: cleaned.x / scale, y: cleaned.y / scale, w: cleaned.pixels.width / scale, h: cleaned.pixels.height / scale };
        } catch {
          /* flat fill instead */
        }
        let area: Box | undefined;
        const inner = innerBox(region, (inkBox.x + inkBox.w / 2) * scale, (inkBox.y + inkBox.h / 2) * scale, inkBox.h * scale);
        if (inner.w > 0) area = { x: inner.x / scale, y: inner.y / scale, w: inner.w / scale, h: inner.h / scale };
        if (area && area.w * area.h < inkBox.w * inkBox.h * 0.6) area = undefined;
        bubbles.push({
          id: uid(),
          ...inkBox,
          area,
          original: f.text,
          translation: f.translation,
          vertical,
          fontSize,
          fill,
          color: look.color,
          patch,
          patchBox,
        });
        continue;
      }
      let area: Box | undefined;
      if (region) {
        const inner = innerBox(region, cx * scale, cy * scale, box.h * scale);
        if (inner.w > 0) area = { x: inner.x / scale, y: inner.y / scale, w: inner.w / scale, h: inner.h / scale };
        if (area && area.w * area.h < box.w * box.h * 0.6) area = undefined;
      }
      // AI boxes include the line spacing: lines are ~1.2× the letters.
      const fontSize = Math.max(10, Math.min(60, (vertical ? box.w : box.h) / (lines * 1.2)));
      const look = lookOfText(px, box, scale, fontSize, Boolean(area));
      bubbles.push({
        id: uid(),
        ...box,
        area,
        original: f.text,
        translation: f.translation,
        vertical,
        fontSize,
        fill: look.fill,
        outline: look.outline || undefined,
        color: look.color,
        patch: look.patch,
        patchBox: look.patchBox,
      });
    }
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
  const start = performance.now();
  const where = { page: page.index + 1, taille: `${bitmap.width}×${bitmap.height}` };
  try {
    if (useVision) {
      const bubbles = await visionPage(bitmap, chapter, signal);
      logInfo('ocr', `Page ${page.index + 1} lue par l’IA : ${bubbles.length} texte(s)`, { ...where, modèle: settings.llm.model, ms: since(start) });
      await patchPage(page.id, { bubbles, status: 'done', stalled: 0 });
      return 'llm';
    }
    const detected = await ocrPage(bitmap, chapter.sourceLang, { minConfidence: settings.minConfidence, signal });
    logInfo('ocr', `Page ${page.index + 1} lue (OCR local) : ${detected.length} texte(s)`, { ...where, langue: chapter.sourceLang, ms: since(start) });
    let bubbles = detected.map((d) => toBubble(d, ''));
    // Save the OCR result first: if translation fails the work is not lost.
    await patchPage(page.id, { bubbles, status: 'translating' });
    setJob(chapter.id, { phase: 'translate' });
    const tStart = performance.now();
    const result = await translateBubbles(bubbles, chapter, signal);
    bubbles = result.bubbles;
    logInfo('translate', `Page ${page.index + 1} traduite`, { page: page.index + 1, moteur: result.engine, ms: since(tStart) });
    await patchPage(page.id, { bubbles, status: 'done', stalled: 0 });
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

let recovery: Promise<void> | null = null;

/**
 * Run once at start-up: a job that died with the previous session (tab
 * reloaded, phone locked, browser killed in the background) is picked up
 * where it stopped, without re-reading the pages that were finished.
 */
export function resumeInterrupted(): Promise<void> {
  recovery ??= (async () => {
    try {
      // Another tab is working: its in-flight pages are not leftovers.
      if (await otherTabIsProcessing()) return;
      for (const id of await resetStalePages()) {
        await refreshStats(id);
        // Only what was still queued: pages in error (the one that may have
        // killed the tab included) wait for the reader to retry them by hand.
        const pending = (await getPages(id)).filter((p) => p.status === 'pending').map((p) => p.id);
        if (pending.length > 0) void startChapter(id, { pageIds: pending });
      }
    } catch {
      /* the library still works; the chapter keeps its "Resume" button */
    }
  })();
  return recovery;
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
    const jobStart = performance.now();
    const st = getSettings();
    logInfo('job', `Traitement de « ${chapter.title} » : ${todo.length} page(s)${opts.translateOnly ? ' (retraduction)' : ''}`, {
      de: chapter.sourceLang,
      vers: chapter.targetLang,
      lecture: visionEnabled() ? 'IA' : 'OCR local',
      traduction: st.provider,
      modèle: visionEnabled() || st.provider === 'llm' ? st.llm.model : undefined,
    });
    setOcrStatusListener((message, progress) =>
      setJob(chapterId, {
        phase: 'download',
        message: progress !== undefined ? `${message} ${Math.round(progress * 100)}%` : message,
      }),
    );
    // Local OCR needs the language up front; the AI vision mode reports it itself.
    if (chapter.sourceLang === AUTO && todo.length > 0 && !visionEnabled() && !opts.translateOnly) {
      const dStart = performance.now();
      const code = await detectChapterLanguage(chapter, pages, controller.signal);
      logInfo('ocr', `Langue détectée : ${code}`, { ms: since(dStart) });
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
          await patchPage(page.id, { bubbles: result.bubbles, status: 'done', stalled: 0 });
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
        logError('job', `Page ${page.index + 1} en erreur : ${message}`, { chapitre: chapter.title });
        await patchPage(page.id, { status: 'error', error: message });
        setJob(chapterId, { failed, message });
      }
      await refreshStats(chapterId);
    }
    await refreshStats(chapterId);
    logInfo('job', `Fin de « ${chapter.title} » : ${done} page(s) faite(s), ${failed} en erreur${controller.signal.aborted ? ', arrêté' : ''}`, {
      ms: since(jobStart),
    });
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
