import { useSyncExternalStore } from 'react';
import { getChapter, getPage, getPages, patchChapter, patchPage, resetStalePages, uid } from './db';
import { bitmapPixels, context2d, createCanvas, decodeImage, pixelsToCanvas, type DecodedImage } from './image';
import { cleanBubble, contrastColor, detectAllBubbles, fitShift, innerBox, maskedCrop, regionFill, snapToText } from './imageproc';
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
import { isDrawnEffect, isSoundEffect, isWatermark } from './text';
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
 * Language given to the AI: a language found automatically is not imposed
 * (one wrong guess, "Korean" for an English scan, would bias every page):
 * the model reads it again on each image. A language chosen by hand is.
 */
function aiSource(chapter: Chapter): string {
  return chapter.autoSource ? AUTO : chapter.sourceLang;
}

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
async function visionPage(bitmap: DecodedImage, chapter: Chapter, signal: AbortSignal, context?: string): Promise<Bubble[]> {
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
      try {
        results[i] = await withRetries(
          () => visionTranslate(slice.image, aiSource(chapter), chapter.targetLang, signal, undefined, { width: slice.width, height: slice.height }, context),
          signal,
        );
      } catch (err) {
        // A model that keeps answering gibberish for one slice: the rest of
        // the page is still lettered instead of the whole page failing.
        if (!/not valid JSON|Empty AI response/.test((err as Error).message)) throw err;
        logWarn('ia', `Morceau ${i + 1}/${slices.length} de la page ignoré : réponse illisible de l’IA`);
        results[i] = { bubbles: [] };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(VISION_PARALLEL, slices.length) }, worker));

  const detected = normaliseSourceCode(results.find((r) => r.sourceLanguage)?.sourceLanguage);
  if (detected && (chapter.sourceLang === AUTO || (chapter.autoSource && detected !== chapter.sourceLang))) {
    // The model told us the language: remember it for edits and retranslations.
    chapter.sourceLang = detected;
    chapter.autoSource = true;
    await patchChapter(chapter.id, { sourceLang: detected, autoSource: true });
  }

  // Every text the model found, in page coordinates, matched to its bubble.
  type Found = { f: (typeof results)[number]['bubbles'][number]; box: Box; region?: (typeof regions)[number] };
  const found: Found[] = [];
  const inRegion = (x: number, y: number) =>
    regions.find((r) => x * scale >= r.x && x * scale <= r.x + r.w && y * scale >= r.y && y * scale <= r.y + r.h);
  for (const [i, { top, h }] of slices.entries()) {
    const ownTop = top === 0 ? 0 : top + overlap / 2;
    const ownBottom = top + h >= H ? H : top + h - overlap / 2;
    const toPage = (b: [number, number, number, number]): Box => {
      const [y0, x0, y1, x1] = b;
      return { x: (x0 / 1000) * W, y: top + (y0 / 1000) * h, w: ((x1 - x0) / 1000) * W, h: ((y1 - y0) / 1000) * h };
    };
    // Models often place their boxes a little off the letters, the same way
    // for the whole image (shifted, or stretched): measured on every text
    // of the slice and corrected for all of them, bubbles included.
    const ys: { at: number; shift: number }[] = [];
    const xs: { at: number; shift: number }[] = [];
    for (const f of results[i].bubbles) {
      const b = toPage(f.box);
      if (b.w * scale < 6 || b.h * scale < 4) continue;
      const snapped = snapToText(px, { x: b.x * scale, y: b.y * scale, w: b.w * scale, h: b.h * scale }, { y: 2.5, x: 0.6, minY: h * scale * 0.04 });
      if (!snapped.found) continue;
      const dy = snapped.y / scale - b.y;
      const dx = snapped.x / scale - b.x;
      // A model's habit is a small offset: a box "found" far away has
      // landed on other lettering (another bubble, the artwork) and is no measure.
      if (Math.abs(dy) > Math.min(Math.max(30, b.h), h * 0.05) || Math.abs(dx) > Math.max(20, b.w * 0.3)) continue;
      ys.push({ at: b.y + b.h / 2, shift: dy });
      xs.push({ at: b.x + b.w / 2, shift: dx });
    }
    // One reading alone is trusted only for a few pixels.
    const limit = ys.length >= 2 ? Infinity : 24;
    const clampShift = (f: (at: number) => number) => (at: number) => Math.max(-limit, Math.min(limit, f(at)));
    const shiftY = clampShift(fitShift(ys));
    const shiftX = clampShift(fitShift(xs));
    const typical = ys.length > 0 ? Math.max(...ys.map((p) => Math.abs(shiftY(p.at))), ...xs.map((p) => Math.abs(shiftX(p.at)))) : 0;
    if (typical > 4) logInfo('ocr', `Cadres de l’IA recalés sur le texte (jusqu’à ${Math.round(typical)} px)`, { morceau: i + 1, mesures: ys.length });
    for (const f of results[i].bubbles) {
      // Untranslatable sound effects ("HUFF" → "HUFF"): the drawn lettering stays.
      if (!f.translation.trim() || sameText(f.text, f.translation)) continue;
      const box = toPage(f.box);
      const dy = shiftY(box.y + box.h / 2);
      const dx = shiftX(box.x + box.w / 2);
      box.y = Math.min(H - box.h, Math.max(0, box.y + dy));
      box.x = Math.min(W - box.w, Math.max(0, box.x + dx));
      const cy = box.y + box.h / 2;
      if (cy < ownTop || cy >= ownBottom) continue;
      const region = inRegion(box.x + box.w / 2, cy);
      // Sound effects drawn on the artwork are not translated, even when the model sends them.
      if (!region && isDrawnEffect(f.text)) continue;
      // Website watermarks are not translated, even over a bubble.
      if (isWatermark(f.text)) continue;
      found.push({ f, box, region });
    }
  }
  // A box a little off its bubble (the model misplaced it): moved into the
  // nearest bubble that has no text of its own, instead of being lettered
  // over the artwork while the bubble stays untranslated.
  const claimed = new Set(found.map((t) => t.region).filter(Boolean));
  for (const t of found) {
    if (t.region) continue;
    const reach = Math.max(t.box.h * 1.5, W * 0.08);
    let best: (typeof regions)[number] | undefined;
    let bestGap = Infinity;
    for (const r of regions) {
      if (claimed.has(r)) continue;
      const rx = r.x / scale;
      const ry = r.y / scale;
      const rw = r.w / scale;
      const rh = r.h / scale;
      const overlapX = Math.min(rx + rw, t.box.x + t.box.w) - Math.max(rx, t.box.x);
      if (overlapX < Math.min(rw, t.box.w) * 0.3) continue;
      const gap = Math.max(0, ry - (t.box.y + t.box.h), t.box.y - (ry + rh));
      if (gap < reach && gap < bestGap) {
        best = r;
        bestGap = gap;
      }
    }
    // Only bubbles that really hold lettering.
    if (best && maskedCrop(px, best).ink) {
      t.region = best;
      claimed.add(best);
    }
  }
  // One bubble read twice (overlapping slices, or split by the model): the
  // most complete reading is kept, never two translations on top of each other.
  const byRegion = new Map<unknown, Found>();
  const kept: Found[] = [];
  for (const t of found) {
    if (t.region) {
      const prev = byRegion.get(t.region);
      if (!prev) {
        byRegion.set(t.region, t);
        kept.push(t);
      } else if (t.f.text.length > prev.f.text.length) {
        kept[kept.indexOf(prev)] = t;
        byRegion.set(t.region, t);
      }
      continue;
    }
    const clash = kept.find((k) => !k.region && overlapShare(k.box, t.box) > 0.5);
    if (clash) {
      if (t.f.text.length > clash.f.text.length) kept[kept.indexOf(clash)] = t;
      continue;
    }
    kept.push(t);
  }
  // Models do not always keep the case: when most of the page is lettered in
  // capitals, so are its short lines ("I'm…"), and they are lettered alike.
  const cased = kept.filter((t) => /\p{Lu}|\p{Ll}/u.test(t.f.text));
  const capitals = cased.filter((t) => t.f.text === t.f.text.toLocaleUpperCase()).length;
  const pageInCaps = cased.length >= 3 && capitals / cased.length >= 0.6;
  // Bubble lettering is never smaller than this, so short lines stay readable.
  const minBubbleFont = W * 0.032;

  const bubbles: Bubble[] = [];
  for (const { f, box, region } of kept) {
    const original = pageInCaps && region ? f.text.toLocaleUpperCase() : f.text;
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
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
        original,
        translation: f.translation,
        vertical,
        // Tiny lettering in a roomy bubble grows to fill it (the layout still fits it).
        fontSize: area ? Math.max(fontSize, minBubbleFont) : fontSize,
        fill,
        color: look.color,
        patch,
        patchBox,
      });
      continue;
    }
    let area: Box | undefined;
    if (!region) {
      // Signs, screens, chats: the box is put back on the letters, so the
      // repaired background covers the original instead of sitting beside it.
      const s = snapToText(px, { x: box.x * scale, y: box.y * scale, w: box.w * scale, h: box.h * scale });
      box.x = s.x / scale;
      box.y = s.y / scale;
    }
    if (region) {
      const inner = innerBox(region, cx * scale, cy * scale, box.h * scale);
      if (inner.w > 0) area = { x: inner.x / scale, y: inner.y / scale, w: inner.w / scale, h: inner.h / scale };
      if (area && area.w * area.h < box.w * box.h * 0.6) area = undefined;
    }
    // AI boxes include the line spacing: lines are ~1.2× the letters.
    let fontSize = Math.max(10, Math.min(60, (vertical ? box.w : box.h) / (lines * 1.2)));
    if (area) fontSize = Math.max(fontSize, minBubbleFont);
    const look = lookOfText(px, box, scale, fontSize, Boolean(area));
    bubbles.push({
      id: uid(),
      ...box,
      area,
      original,
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
  return bubbles;
}

/** Share of the smaller box covered by the other one. */
function overlapShare(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.max(1, Math.min(a.w * a.h, b.w * b.h));
}

/** Part of a bubble's area that lies on its page. */
function visiblePart(b: Bubble, pageHeight: number): Box {
  const a = b.area ?? b;
  const y0 = Math.max(0, a.y);
  const y1 = Math.min(pageHeight, a.y + a.h);
  // A little wider: the original letters sit around the lettering area.
  const padX = a.w * 0.15;
  return { x: a.x - padX, y: y0 - 4, w: a.w + padX * 2, h: Math.max(0, y1 - y0) + 8 };
}

function coversCentre(zone: Box, b: Box): boolean {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  return cx >= zone.x && cx <= zone.x + zone.w && cy >= zone.y && cy <= zone.y + zone.h;
}

/**
 * A speech bubble cut by the page break (top half at the bottom of this
 * page, the rest at the top of the next one) was read as two pieces and
 * only one got translated. Both halves are put back together, read and
 * translated as one bubble, and the translation is lettered across the
 * break: the same text block is placed on both pages, each showing its part.
 */
async function stitchSeam(page: Page, bitmap: DecodedImage, chapter: Chapter, signal: AbortSignal, bubbles: Bubble[], context?: string): Promise<Bubble[]> {
  const W = bitmap.width;
  const H = bitmap.height;
  const stripH = Math.min(H, Math.round(W * 1.2));
  const stripTop = H - stripH;
  const bottomPx = bitmapPixels(bitmap, 1, { x: 0, y: stripTop, w: W, h: stripH });
  const cut = detectAllBubbles(bottomPx).filter((r) => r.y + r.h >= stripH - 2 && r.h < stripH * 0.95);
  if (cut.length === 0) return bubbles;

  const next = (await getPages(chapter.id)).find((p) => p.index === page.index + 1);
  if (!next) return bubbles;
  const nextBitmap = await decodeImage(next.blob);
  try {
    // The next page drawn at this page's width (chapters sometimes mix sizes).
    const k = W / nextBitmap.width;
    if (Math.abs(k - 1) > 0.02) return bubbles;
    const nextStripH = Math.min(nextBitmap.height, Math.round(nextBitmap.width * 1.2));
    const topPx = bitmapPixels(nextBitmap, 1, { x: 0, y: 0, w: nextBitmap.width, h: nextStripH });
    const starts = detectAllBubbles(topPx).filter((r) => r.y <= 1 && r.h < nextStripH * 0.95);
    let result = bubbles;
    const continued: Bubble[] = [];
    for (const a of cut) {
      // Same bubble: its two halves line up across the break.
      const b = starts.find((r) => {
        const overlap = Math.min(a.x + a.w, r.x + r.w) - Math.max(a.x, r.x);
        return overlap > Math.min(a.w, r.w) * 0.6;
      });
      if (!b) continue;
      const margin = 12;
      const fromY = Math.max(0, a.y - margin);
      const partA = stripH - fromY;
      const partB = Math.min(nextStripH, b.y + b.h + margin);
      const k2 = Math.min(1, VISION_MAX_SIDE / Math.max(W, partA + partB));
      const canvas = createCanvas(W * k2, (partA + partB) * k2);
      const c = context2d(canvas);
      c.imageSmoothingQuality = 'high';
      c.drawImage(bitmap.source, 0, stripTop + fromY, W, partA, 0, 0, canvas.width, partA * k2);
      c.drawImage(nextBitmap.source, 0, 0, nextBitmap.width, partB, 0, partA * k2, canvas.width, partB * k2);
      const image = canvas.toDataURL('image/jpeg', 0.88);
      const size = { width: canvas.width, height: canvas.height };
      canvas.width = canvas.height = 0;
      const answer = await withRetries(() => visionTranslate(image, aiSource(chapter), chapter.targetLang, signal, undefined, size, context), signal);
      const items = answer.bubbles.filter((f) => f.translation.trim() && !sameText(f.text, f.translation) && !isSoundEffect(f.text) && !isWatermark(f.text));
      if (items.length === 0) continue;
      const original = items.map((f) => f.text).join(' ');
      const translation = items.map((f) => f.translation).join(' ');

      // The whole bubble in this page's pixels: from its top here to its end on the next page.
      const top = stripTop + a.y;
      const bottom = H + b.y + b.h;
      const left = Math.max(a.x, b.x);
      const right = Math.min(a.x + a.w, b.x + b.w);
      const padX = (right - left) * 0.12;
      const padY = (bottom - top) * 0.1;
      const area: Box = { x: left + padX, y: top + padY, w: right - left - padX * 2, h: bottom - top - padY * 2 };
      const fill = regionFill(bottomPx, a);
      const fontSize = W * 0.032;
      const half = (px: typeof bottomPx, r: typeof a, dy: number): Pick<Bubble, 'x' | 'y' | 'w' | 'h' | 'patch' | 'patchBox'> => {
        const ink = maskedCrop(px, r).ink;
        if (!ink) return { x: r.x + r.w / 2, y: dy + r.y + r.h / 2, w: 1, h: 1 };
        const pad = Math.max(2, fontSize * 0.5);
        try {
          const cleaned = cleanBubble(px, r, { x: ink.x - pad, y: ink.y - pad, w: ink.w + pad * 2, h: ink.h + pad * 2 }, fill);
          return {
            x: ink.x,
            y: dy + ink.y,
            w: ink.w,
            h: ink.h,
            patch: pixelsToCanvas(cleaned.pixels).toDataURL('image/jpeg', 0.92),
            patchBox: { x: cleaned.x, y: dy + cleaned.y, w: cleaned.pixels.width, h: cleaned.pixels.height },
          };
        } catch {
          return { x: ink.x, y: dy + ink.y, w: ink.w, h: ink.h };
        }
      };
      const shared = { original, translation, fontSize, fill, color: contrastColor(fill) };
      const upper: Bubble = { id: uid(), ...half(bottomPx, a, stripTop), ...shared, area, seam: 'next' };
      const lower: Bubble = { id: uid(), ...half(topPx, b, 0), ...shared, area: { ...area, y: area.y - H }, seam: 'prev' };
      // What the page read on its own of this bubble is replaced.
      const zoneA = { x: a.x, y: stripTop + a.y, w: a.w, h: a.h };
      result = [...result.filter((x) => !coversCentre(zoneA, x)), upper];
      continued.push(lower);
      logInfo('ocr', `Bulle coupée entre les pages ${page.index + 1} et ${page.index + 2} recollée et traduite`, { page: page.index + 1 });
    }
    if (continued.length > 0) {
      const fresh = await getPage(next.id);
      if (fresh) {
        const zones = continued.map((l) => visiblePart(l, nextBitmap.height));
        const kept = fresh.bubbles.filter((x) => x.seam !== 'prev' && !zones.some((z) => coversCentre(z, x)));
        await patchPage(next.id, { bubbles: [...kept, ...continued] });
      }
    }
    return result;
  } finally {
    nextBitmap.close();
  }
}

/** Lines kept as context for the AI: enough for names and tone, short enough to stay cheap. */
const CONTEXT_LINES = 14;

/**
 * The last bubbles translated before this page ("original → translation"),
 * so that each page is translated knowing the story so far: same names,
 * same form of address, same tone from one page to the next.
 */
export async function storySoFar(chapter: Chapter, pageIndex: number): Promise<string | undefined> {
  try {
    const before = (await getPages(chapter.id)).filter((p) => p.index < pageIndex && p.index >= pageIndex - 3 && p.status === 'done');
    const lines = before
      .sort((a, b) => a.index - b.index)
      .flatMap((p) => p.bubbles.filter((b) => b.seam !== 'prev' && !b.hidden && b.translation.trim()).sort((a, b) => a.y - b.y))
      .map((b) => `${b.original.replace(/\s+/g, ' ').trim()} → ${b.translation.replace(/\s+/g, ' ').trim()}`)
      .slice(-CONTEXT_LINES);
    return lines.length > 0 ? lines.join('\n') : undefined;
  } catch {
    return undefined;
  }
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
  let bitmap: DecodedImage;
  try {
    bitmap = await decodeImage(page.blob);
  } catch (err) {
    // iOS sometimes loses the bytes of a blob held in memory ("Loading
    // error."): the copy stored in the database still reads fine.
    const fresh = await getPage(page.id);
    if (!fresh) throw err;
    logWarn('job', `Image de la page ${page.index + 1} relue depuis le stockage : ${(err as Error).message}`);
    page.blob = fresh.blob;
    bitmap = await decodeImage(fresh.blob);
  }
  const start = performance.now();
  const where = { page: page.index + 1, taille: `${bitmap.width}×${bitmap.height}` };
  try {
    if (useVision) {
      const context = await storySoFar(chapter, page.index);
      let bubbles = await visionPage(bitmap, chapter, signal, context);
      try {
        bubbles = await stitchSeam(page, bitmap, chapter, signal, bubbles, context);
      } catch (err) {
        if ((err as Error).name === 'AbortError') throw err;
        logWarn('ocr', `Bulle à cheval sur la page ${page.index + 2} non recollée : ${(err as Error).message.slice(0, 120)}`);
      }
      // The end of a bubble begun on the previous page is already lettered.
      const own = (await getPage(page.id))?.bubbles.filter((b) => b.seam === 'prev') ?? [];
      if (own.length > 0) bubbles = [...bubbles.filter((b) => !own.some((o) => coversCentre(visiblePart(o, bitmap.height), b))), ...own];
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
