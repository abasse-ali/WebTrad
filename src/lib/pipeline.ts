import { useSyncExternalStore } from 'react';
import { getChapter, getPage, getPages, patchChapter, patchPage, resetStalePages, uid } from './db';
import { bitmapPixels, context2d, createCanvas, decodeImage, pixelsToCanvas, type DecodedImage } from './image';
import { cleanBubble, cleanPaper, contrastColor, luminance, detectAllBubbles, enclosingBubble, boxSkew, boxSlant, findTextBlocks, fitShift, growToLetters, growToText, innerBox, letterHeight, letterHeightByEdges, paperShape, plainAround, plainPaper, trimStrokes, maskedCrop, meanLuminance, regionFill, snapToText, type BubbleRegion, type Pixels } from './imageproc';
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
import { normaliseCase, tidyTranslation, type Box } from './text';
import { translateTexts } from './translate';
import { CONTENT_REFUSED, forgetProofModel, lastRateLimitAt, proofModelFor, proofreadTexts, visionTranslate } from './translate/llm';
import { TranslateError } from './translate/types';
import { isDrawnEffect, isScreenChat, isSeriesTitle, isSoundEffect, isWatermark } from './text';
import { seriesOf } from './series';
import { charactersFor, rememberSpeakers } from './cast';
import { alignToBubbles } from './align';
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
  /** Waiting for another chapter to finish: chapters are processed one at a time. */
  queued?: boolean;
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
    outlineColor: d.outline ? d.outlineColor : undefined,
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
export async function withRetries<T>(run: () => Promise<T>, signal: AbortSignal, waits = [4000, 15000], timeoutRetries = 1): Promise<T> {
  let limited = 0;
  let timeouts = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      const retryable = !(err instanceof TranslateError) || err.retryable;
      // Rate limits (429) only mean "wait": the request waits for the window
      // to reset (see llm.ts) and is tried again, up to 8 times.
      const rateLimited = /HTTP 429/.test((err as Error).message);
      if (rateLimited) limited++;
      // No answer at all: the same image sent again hung the same way (three
      // times 3 minutes for two pages read in 8 s once sent one by one).
      const timedOut = /no complete answer/.test((err as Error).message);
      if (timedOut) timeouts++;
      const giveUp = rateLimited ? limited > 8 : attempt - limited >= waits.length || timeouts > timeoutRetries;
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
  // Accents apart: "PC Cafe" → "PC Café" is the same sign, left as drawn.
  const norm = (t: string) => t.normalize('NFD').replace(/\p{M}+/gu, '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  return norm(a) !== '' && norm(a) === norm(b);
}

/** Tallest slice sent to the AI, in page widths; past it the page is cut. */
const SLICE_MAX_RATIO = 2.65;

/** Height of the slices a page is cut in, and how much they overlap (page pixels). */
export function sliceLayout(W: number, H: number): { sliceH: number; overlap: number; count: number } {
  if (H <= W * SLICE_MAX_RATIO) return { sliceH: H, overlap: 0, count: 1 };
  const target = W * 2.2;
  const overlap = Math.round(target * 0.12);
  const count = Math.ceil((H - overlap) / (target - overlap));
  const sliceH = Math.ceil((H + overlap * (count - 1)) / count);
  return { sliceH, overlap, count };
}

/** Height of the original letters → font size given to the layout (see `visionPage`). */
const LETTERS_TO_FONT = 0.8;

/** Pages of a chapter read by the AI at the same time. */
const PAGE_PARALLEL = 2;

/** Slices of the page read by the AI at the same time (free tiers allow ~40 requests a minute). */
const VISION_PARALLEL = 3;

/** AI vision mode: the page is cut in slices, each read and translated by one request. */
export async function visionPage(
  bitmap: DecodedImage,
  chapter: Chapter,
  signal: AbortSignal,
  context?: string,
  /** Several pages read together: an image left unanswered is not sent again (the pages are read one by one instead). */
  opts: { group?: boolean } = {},
): Promise<Bubble[]> {
  const W = bitmap.width;
  const H = bitmap.height;
  const series = seriesOf(chapter.title).name;
  // Tall slices: a webtoon page costs fewer requests (vision models read tall
  // images well). A page a little taller than one slice is read whole, and a
  // longer one is cut in slices of equal height: an 800×1828 page was read in
  // two requests, the second one a strip of blank paper.
  const { sliceH, overlap } = sliceLayout(W, H);
  const scale = Math.min(1, Math.sqrt(12_000_000 / (W * H)));
  const px = bitmapPixels(bitmap, scale);
  const regions = detectAllBubbles(px);

  type Slice = { top: number; h: number; image: string; width: number; height: number; rescue?: Box[] };
  const makeSlice = (top: number, h: number): Slice => {
    const k = Math.min(1, VISION_MAX_SIDE / Math.max(W, h));
    const canvas = createCanvas(W * k, h * k);
    const c = context2d(canvas);
    c.imageSmoothingQuality = 'high';
    c.drawImage(bitmap.source, 0, top, W, h, 0, 0, canvas.width, canvas.height);
    const slice = { top, h, image: canvas.toDataURL('image/jpeg', 0.88), width: canvas.width, height: canvas.height };
    canvas.width = canvas.height = 0;
    return slice;
  };
  const slices: Slice[] = [];
  for (let top = 0; top < H; top += sliceH - overlap) {
    const h = Math.min(sliceH, H - top);
    slices.push(makeSlice(top, h));
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
          () => visionTranslate(slice.image, aiSource(chapter), chapter.targetLang, signal, undefined, { width: slice.width, height: slice.height }, context, chapter.layout),
          signal,
          undefined,
          opts.group ? 0 : 1,
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
  // Only while the language is not known yet: one page the model took for
  // Korean switched a whole English chapter, and the page read on the device
  // after it found no text at all.
  if (detected && chapter.sourceLang === AUTO) {
    // The model told us the language: remember it for edits and retranslations.
    chapter.sourceLang = detected;
    chapter.autoSource = true;
    await patchChapter(chapter.id, { sourceLang: detected, autoSource: true });
  }

  // Every text the model found, in page coordinates, matched to its bubble.
  type Found = { f: (typeof results)[number]['bubbles'][number]; box: Box; region?: (typeof regions)[number]; block?: Box; doubtful?: boolean; /** The box as the model gave it (once placed on the page). */ model?: Box };
  const found: Found[] = [];
  const inRegion = (x: number, y: number) =>
    regions.find((r) => x * scale >= r.x && x * scale <= r.x + r.w && y * scale >= r.y && y * scale <= r.y + r.h);
  // Blocks of lettering found on the page itself (page pixels).
  const pageBlocks = findTextBlocks(px).map((b) => ({ x: b.x / scale, y: b.y / scale, w: b.w / scale, h: b.h / scale }));
  const inkOf = new Map<(typeof regions)[number], boolean>();
  const withInk = (r: (typeof regions)[number]) => {
    if (!inkOf.has(r)) inkOf.set(r, maskedCrop(px, r).ink !== null);
    return inkOf.get(r)!;
  };
  // Bubbles the detection leaves out for their shape (spiky shouts, torn
  // rims, bubbles as wide as the page) are found from their lettering: the
  // plain paper around it, up to its outline. Such a text is then erased
  // and lettered like any bubble, instead of being repaired as artwork,
  // which took the outline of the bubble away with the letters.
  const shaped: (typeof regions)[number][] = [];
  // The white of the page between panels, taken for a bubble when a small
  // bubble's thin outline is open: the translation was lettered huge in the
  // middle of the page and the bubble kept its English.
  const pageBackground = (e: Box) => e.w >= px.width * 0.8 && (e.x <= 2 || e.x + e.w >= px.width - 2);
  const shapedBubble = (box: Box, block?: Box): (typeof regions)[number] | undefined => {
    const on = block ?? { x: box.x + box.w * 0.25, y: box.y + box.h * 0.25, w: box.w * 0.5, h: box.h * 0.5 };
    const seed = { x: on.x * scale, y: on.y * scale, w: on.w * scale, h: on.h * scale };
    const cx = seed.x + seed.w / 2;
    const cy = seed.y + seed.h / 2;
    const known = shaped.find((e) => {
      const row = Math.round(cy) - e.y;
      return row >= 0 && row < e.h && e.spans[row * 2] >= 0 && cx >= e.spans[row * 2] && cx <= e.spans[row * 2 + 1];
    });
    if (known) return known;
    let e = enclosingBubble(px, seed);
    // A white bubble on a light drawing (a beige wall): the wall joined its
    // white and nothing was found. Its translation was written grey, over a
    // grey patch of rebuilt wall. Only what is white then, if it holds the
    // whole text with room around it (not the white of outlined letters
    // drawn on a wall).
    if (!e || pageBackground(e)) {
      const white = enclosingBubble(px, seed, 238);
      // The letters without the bubble's tail found with them.
      const t = trimStrokes(px, seed);
      const m = Math.max(4, t.h * 0.15);
      if (white && white.x <= t.x - m && white.y <= t.y - m && white.x + white.w >= t.x + t.w + m && white.y + white.h >= t.y + t.h + m) e = white;
    }
    if (!e || pageBackground(e)) return undefined;
    if (!block) {
      // No lettering was found there: only a bubble whose ink is about the size of the text read.
      const ink = maskedCrop(px, e).ink;
      const ratio = ink ? ink.w / Math.max(1, box.w * scale) : 0;
      if (ratio < 0.4 || ratio > 2.5) return undefined;
    }
    shaped.push(e);
    return e;
  };
  // Every box the model drew, wherever it went (sound effects and texts left
  // as drawn included): lettering under none of them was not read at all.
  const seen: Box[] = [];
  const chat: Box[] = [];
  const untranslated: { text: string; translation: string }[] = [];
  const placeSlice = (i: number) => {
    const { top, h, rescue } = slices[i];
    const ownTop = rescue || top === 0 ? top : top + overlap / 2;
    const ownBottom = rescue ? top + h : top + h >= H ? H : top + h - overlap / 2;
    const rawBox = (b: [number, number, number, number]): Box => {
      const [y0, x0, y1, x1] = b;
      return { x: (x0 / 1000) * W, y: top + (y0 / 1000) * h, w: ((x1 - x0) / 1000) * W, h: ((y1 - y0) / 1000) * h };
    };
    // Boxes squeezed or stretched by the model are first mapped back onto
    // the bubbles of the slice (see align.ts); small offsets are fixed below.
    const sliceBubbles = regions
      .filter((r) => withInk(r) && (r.y + r.h / 2) / scale >= top && (r.y + r.h / 2) / scale < top + h)
      .map((r) => ({ x: r.x / scale, y: r.y / scale, w: r.w / scale, h: r.h / scale }));
    const dialogue = results[i].bubbles
      .filter((f) => f.translation.trim() && !isDrawnEffect(f.text) && !isWatermark(f.text) && !isScreenChat(f.text))
      .map((f) => rawBox(f.box));
    // The places where texts really are: the bubbles, and the blocks of
    // lettering (a little enlarged: a model's box is never tight). A box
    // already on letters counts as well placed, so a page of correct boxes
    // is never stretched away.
    const sliceBlocks = pageBlocks
      .filter((b) => b.y + b.h / 2 >= top && b.y + b.h / 2 < top + h)
      .map((b) => ({ x: b.x - b.w * 0.3, y: b.y - b.h * 0.6, w: b.w * 1.6, h: b.h * 2.2 }));
    // Far more texts than places with lettering: the model made some up
    // (26 texts for a page of ten, lines that are on no page). Its texts that
    // land on no lettering are then left out, never moved onto a bubble.
    const doubtful = dialogue.length > (sliceBubbles.length + sliceBlocks.length) * 1.5 + 4;
    if (doubtful) logWarn('ocr', `Morceau ${i + 1} : ${dialogue.length} textes pour ${sliceBlocks.length} blocs de lettrage, textes inventés écartés`);
    const mapping = alignToBubbles(dialogue, [...sliceBubbles, ...sliceBlocks], { top, bottom: top + h });
    if (mapping.a !== 1 || mapping.b !== 0) {
      logInfo('ocr', `Cadres de l’IA replacés sur les bulles (échelle ${mapping.a.toFixed(2)}, décalage ${Math.round(mapping.b)} px)`, {
        morceau: i + 1,
        bulles: mapping.matched,
      });
    }
    const toPage = (b: [number, number, number, number]): Box => {
      const r = rawBox(b);
      const c = mapping.a * (r.y + r.h / 2) + mapping.b;
      return { ...r, y: c - (r.h * mapping.a) / 2, h: r.h * mapping.a };
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
      seen.push(rawBox(f.box), toPage(f.box));
      // A sentence sent back untranslated (the model copied the English): it
      // is translated as text afterwards instead of being taken for a sound
      // effect and left out (a whole page stayed in English).
      // So is a line in a bubble sent back the same or with no translation
      // ("O-OKAY…", "BON APPETIT…", "WOW… NICE!", a whole sentence left
      // out): it was dropped silently, stayed in English, and was never
      // proofread nor read again.
      const words = f.text.trim().split(/\s+/).filter((w) => /\p{L}{2,}/u.test(w)).length;
      const centre = toPage(f.box);
      const inBubble = inRegion(centre.x + centre.w / 2, centre.y + centre.h / 2) !== undefined;
      const notTranslated = !f.translation.trim() || sameText(f.text, f.translation);
      if (notTranslated && !isDrawnEffect(f.text) && !isWatermark(f.text) && (words >= 3 || (words >= 1 && inBubble))) {
        f.translation = '';
        untranslated.push(f);
      }
      // Untranslatable sound effects ("HUFF" → "HUFF"): the drawn lettering stays.
      else if (!f.translation.trim() || sameText(f.text, f.translation)) continue;
      // Nothing to translate in "…?" or "!!": the drawn marks stay as they are.
      if (!/[\p{L}\p{N}]/u.test(f.text)) continue;
      const box = toPage(f.box);
      const dy = shiftY(box.y + box.h / 2);
      const dx = shiftX(box.x + box.w / 2);
      box.y = Math.min(H - box.h, Math.max(0, box.y + dy));
      box.x = Math.min(W - box.w, Math.max(0, box.x + dx));
      // A box wider than the page (it happens) is kept within it.
      if (box.x < 0 || box.x + box.w > W) {
        const x0 = Math.max(0, box.x);
        box.w = Math.min(W, box.x + box.w) - x0;
        box.x = x0;
      }
      const cy = box.y + box.h / 2;
      if (cy < ownTop || cy >= ownBottom) continue;
      let region = inRegion(box.x + box.w / 2, cy);
      // A word or two in letters as tall as a panel ("TA-DA", "DUUN"): a
      // drawn sound effect, never lettered over, whatever its region (the
      // white inside a letter was taken for a bubble). Its translation was
      // written small in a blurred patch that wiped out the drawing.
      const shortText = words <= 2 && f.text.replace(/[^\p{L}\p{N}]/gu, '').length <= 12;
      if (shortText && box.h > W * 0.13 && (!region || f.sfx || isDrawnEffect(f.text) || isSoundEffect(f.text))) continue;
      // Sound effects drawn on the artwork are not translated, even when the
      // model sends them. A cry typed small ("UGH!") in a bubble of an odd
      // shape is dialogue: its bubble is looked for before it is left out.
      if (!region && isDrawnEffect(f.text)) {
        // A known sound effect ("BRUSH", "DUN", "BOW") outside any bubble is
        // drawn: never lettered over (a white stretch of sky taken for its
        // bubble had "DUN" erased with the face beside it).
        if (box.h > W * 0.06 || isSoundEffect(f.text)) continue;
        // The lettering under it, when found: a short cry ("WHAT...?!") in a
        // bubble joined to a longer one is no longer compared with the ink
        // of both, and left in English.
        const under = pageBlocks.find((b) => overlapShare(b, box) > 0.3);
        region = shapedBubble(box, under);
        if (!region) continue;
      }
      // A sound effect over a wide light area taken for a bubble (a pillow,
      // a wall): drawn, left as it is ("SNORE" lettered tiny on a pillow).
      // So is what the model itself calls a sound effect.
      const wide = region ? (region.w / scale) * (region.h / scale) > box.w * box.h * 25 : true;
      if ((isSoundEffect(f.text) || f.sfx) && wide) continue;
      // Website watermarks are not translated, even over a bubble.
      if (isWatermark(f.text)) continue;
      // Chat lines on a drawn screen stay as drawn: too small to letter over.
      if (isScreenChat(f.text)) {
        chat.push(box);
        continue;
      }
      // The series' logo, drawn on the artwork, keeps its title.
      if (!region && isSeriesTitle(f.text, series)) continue;
      // A second look at lettering the model missed: only texts on it.
      const cx = box.x + box.w / 2;
      // (The same text exactly: "WHAT...?!" is not "HEY! WHAT THE HELL…".)
      const letters = (t: string) => t.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
      if (rescue && found.some((t) => letters(t.f.text) === letters(f.text))) continue;
      if (rescue && !rescue.some((b) => overlapShare(b, box) > 0.3 || (cx >= b.x - b.w * 0.3 && cx <= b.x + b.w * 1.3 && cy >= b.y - b.h && cy <= b.y + b.h * 2))) continue;
      found.push({ f, box, region, doubtful, model: { ...box } });
    }
  };
  for (let i = 0; i < slices.length; i++) placeSlice(i);
  // The other lines of that chat, read without their "OO:" (the model drops
  // it at times), are left as drawn too: outside any bubble, among its lines.
  if (chat.length > 0) {
    const nearChat = (b: Box) =>
      chat.some((c) => {
        const line = Math.max(c.h, b.h);
        const overlapX = Math.min(c.x + c.w, b.x + b.w) - Math.max(c.x, b.x);
        return overlapX > 0 && b.y + b.h > c.y - line * 2.5 && b.y < c.y + c.h + line * 2.5;
      });
    for (let k = found.length - 1; k >= 0; k--) if (!found[k].region && nearChat(found[k].box)) found.splice(k, 1);
  }
  // Lettering in a bubble that no box of the model came near: the model
  // skipped it (two spiky bubbles drawn joined, left in English). The strip
  // around it is sent once more, alone, and only its texts are kept.
  // Lettering is dark ink on white paper, with few tones between them; the
  // folds of a white shirt, found as "blocks" too, are mostly grey shading.
  const printedInk = (b: Box) => {
    let dark = 0;
    let mid = 0;
    let all = 0;
    const x0 = Math.max(0, Math.floor(b.x));
    const y0 = Math.max(0, Math.floor(b.y));
    const x1 = Math.min(px.width, Math.ceil(b.x + b.w));
    const y1 = Math.min(px.height, Math.ceil(b.y + b.h));
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const o = (y * px.width + x) * 4;
        const l = 0.299 * px.data[o] + 0.587 * px.data[o + 1] + 0.114 * px.data[o + 2];
        all++;
        if (l < 90) dark++;
        else if (l <= 225) mid++;
      }
    return all > 0 && dark / all >= 0.08 && mid / all <= 0.25;
  };
  const missed = pageBlocks.filter((b) => {
    if (b.h > W * 0.25 || b.w < W * 0.05) return false;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    // Close to a text read is that text (a box drawn a little off): read
    // again, a page took a minute more for nothing. Unless the lettering
    // lies in another bubble than the text read, touching it: that one was
    // left untranslated.
    const own = inRegion(cx, cy);
    const near = (t: Box) => cx >= t.x - t.w * 0.3 && cx <= t.x + t.w * 1.3 && cy >= t.y - t.h * 0.5 && cy <= t.y + t.h * 1.5;
    const otherBubble = (t: Box) => own !== undefined && inRegion(t.x + t.w / 2, t.y + t.h / 2) !== own;
    if (seen.some((t) => overlapShare(b, t) > 0.2 || (near(t) && !otherBubble(t)))) return false;
    const seed = { x: b.x * scale, y: b.y * scale, w: b.w * scale, h: b.h * scale };
    if (!printedInk(seed)) return false;
    const r = inRegion(cx, cy);
    return r ? withInk(r) : enclosingBubble(px, seed) !== null;
  });
  if (missed.length > 0 && !signal.aborted) {
    missed.sort((a, b) => a.y - b.y);
    const group = missed.filter((b) => b.y + b.h <= missed[0].y + sliceH * 0.7);
    const y0 = Math.min(...group.map((b) => b.y));
    const y1 = Math.max(...group.map((b) => b.y + b.h));
    const pad = Math.max(W * 0.35, (W * 0.9 - (y1 - y0)) / 2);
    const top = Math.max(0, Math.round(y0 - pad));
    const h = Math.min(H, Math.round(y1 + pad)) - top;
    logInfo('ocr', `Lettrage oublié par l’IA : nouvelle lecture de ce passage`, { blocs: group.length, haut: Math.round(y0) });
    try {
      const slice = { ...makeSlice(top, h), rescue: group };
      const answer = await withRetries(
        () => visionTranslate(slice.image, aiSource(chapter), chapter.targetLang, signal, undefined, { width: slice.width, height: slice.height }, context, chapter.layout),
        signal,
      );
      slices.push(slice);
      results.push(answer);
      const before = found.length;
      placeSlice(slices.length - 1);
      if (found.length === before) logInfo('ocr', 'Nouvelle lecture sans texte de plus');
    } catch (err) {
      if (signal.aborted || (err instanceof TranslateError && err.fatal)) throw err;
      logWarn('ocr', `Nouvelle lecture impossible : ${(err as Error).message.slice(0, 120)}`);
    }
  }
  if (untranslated.length > 0 && !signal.aborted) {
    try {
      // Lettering in Latin letters in a chapter said to be Korean or Japanese
      // (the model reported the language of a drawn effect): English.
      const latin = untranslated.every((f) => !/[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Cyrillic}\p{Script=Thai}]/u.test(f.text));
      const cjk = ['ko', 'ja', 'zh', 'zh-Hans', 'zh-Hant', 'ru', 'th'].includes(chapter.sourceLang);
      const { translations } = await translateTexts(
        untranslated.map((f) => f.text),
        chapter.sourceLang !== AUTO && !(latin && cjk) ? chapter.sourceLang : 'en',
        chapter.targetLang,
        signal,
      );
      untranslated.forEach((f, k) => (f.translation = tidyTranslation(translations[k] ?? '', f.text)));
      logInfo('ocr', `${untranslated.length} texte(s) rendu(s) non traduit(s) par l’IA : traduit(s) à part`);
    } catch (err) {
      if (signal.aborted) throw err;
      logWarn('ocr', `Textes non traduits par l’IA : ${(err as Error).message.slice(0, 120)}`);
    }
    for (let k = found.length - 1; k >= 0; k--) if (!found[k].f.translation.trim()) found.splice(k, 1);
  }
  // Lettering found on the page itself. A box that lies on no lettering
  // (the model placed it wrong, sometimes a bubble's height away) takes the
  // nearest block of lettering that no other box has, in reading order.
  const blocks = pageBlocks;
  const grow = (b: Box, k: number): Box => ({ x: b.x - b.w * k, y: b.y - b.h * k, w: b.w * (1 + 2 * k), h: b.h * (1 + 2 * k) });
  const inside = (b: Box, x: number, y: number) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
  const taken = new Set<number>();
  const loose: Found[] = [];
  for (const t of found) {
    const cx = t.box.x + t.box.w / 2;
    const cy = t.box.y + t.box.h / 2;
    let hit = blocks.findIndex((b, j) => !taken.has(j) && inside(grow(b, 0.4), cx, cy));
    // A box much bigger than its letters (the model often frames a whole
    // bubble, or more): the block of lettering lying mostly inside it.
    if (hit < 0) hit = blocks.findIndex((b, j) => !taken.has(j) && overlapShare(b, t.box) > 0.6);
    // Outside any bubble, a box shifted sideways onto the drawing beside
    // the text (a sound effect next to it): the block of lettering it
    // overlaps at the same height, letters about the size the box says.
    if (hit < 0 && !t.region) {
      hit = blocks.findIndex((b, j) => {
        if (taken.has(j)) return false;
        const ox = Math.min(b.x + b.w, t.box.x + t.box.w) - Math.max(b.x, t.box.x);
        const oy = Math.min(b.y + b.h, t.box.y + t.box.h) - Math.max(b.y, t.box.y);
        return ox > Math.min(b.w, t.box.w) * 0.15 && oy > Math.min(b.h, t.box.h) * 0.6 && b.h < t.box.h * 1.8 && b.w < t.box.w * 1.8;
      });
    }
    if (hit >= 0) {
      taken.add(hit);
      t.block = blocks[hit];
      // Outside any recognised bubble the box itself was used to erase and
      // to letter: the translation landed where the model drew its box
      // (above the bubble, over the drawing), not on the letters. It now
      // takes the place of the letters found.
      if (!t.region) {
        const b = blocks[hit];
        // Only part of the lines found (the rest over the drawing, not on
        // paper): the model's box, holding the block, keeps its width so
        // the whole text is erased.
        if (overlapShare(b, t.box) > 0.8 && b.w < t.box.w * 0.6) {
          const x0 = Math.min(b.x, t.box.x);
          const y0 = Math.min(b.y, t.box.y);
          t.box = { x: x0, y: y0, w: Math.max(b.x + b.w, t.box.x + t.box.w) - x0, h: Math.max(b.y + b.h, t.box.y + t.box.h) - y0 };
        } else if (overlapShare(t.box, b) > 0.9 && b.w * b.h > t.box.w * t.box.h * 1.6) {
          // A block much bigger than the model's box around it: the marks
          // of a bubble's rim (spikes of an open bubble) taken with the
          // letters. The model's box stays; its lines are grown to below.
        } else t.box = { ...b };
        t.region = inRegion(t.box.x + t.box.w / 2, t.box.y + t.box.h / 2);
      }
    }
    // In a bubble that holds lettering: in place, even if its letters are too small to be found as a block.
    else if (!t.region) {
      // Light text on a dark screen or panel (a game chat) is not found as
      // lettering on paper: such a box is left where the model put it.
      if (meanLuminance(px, { x: t.box.x * scale, y: t.box.y * scale, w: t.box.w * scale, h: t.box.h * scale }) >= 110) loose.push(t);
    }
  }
  let lastY = -Infinity;
  for (const t of loose.sort((a, b) => a.box.y - b.box.y)) {
    // The same text already placed (read twice by overlapping slices): the
    // copy is not moved onto another bubble's lettering, it goes. So does a
    // text of a slice where the model made texts up.
    if (t.doubtful || found.some((o) => o !== t && !loose.includes(o) && similarText(o.f.text, t.f.text))) {
      found.splice(found.indexOf(t), 1);
      continue;
    }
    const cy = t.box.y + t.box.h / 2;
    let best = -1;
    let bestD = Infinity;
    for (const [j, b] of blocks.entries()) {
      if (taken.has(j)) continue;
      // Lettering in a bubble that already has its text is that text's.
      const held = inRegion(b.x + b.w / 2, b.y + b.h / 2);
      if (held && found.some((o) => o !== t && o.region === held)) continue;
      const by = b.y + b.h / 2;
      const d = Math.abs(by - cy);
      const overlapX = Math.min(b.x + b.w, t.box.x + t.box.w + W * 0.15) - Math.max(b.x, t.box.x - W * 0.15);
      // Reading order kept; within about half a page width; side by side; a block about as wide as the text read.
      if (by < lastY || d > W * 0.6 || overlapX <= 0 || b.w < t.box.w * 0.3 || b.w > t.box.w * 2.2) continue;
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    }
    if (best < 0) continue;
    taken.add(best);
    const b = blocks[best];
    lastY = b.y + b.h / 2;
    t.box = { ...b };
    t.block = b;
    t.region = inRegion(b.x + b.w / 2, b.y + b.h / 2);
    logInfo('ocr', `Texte replacé sur le lettrage de la page (${Math.round(bestD)} px)`, { texte: t.f.text.slice(0, 40) });
  }
  for (const t of found) {
    if (!t.region) t.region = shapedBubble(t.box, t.block);
  }
  // The lettering of a bubble: the blocks of letter-sized marks found in it
  // (a big drawn sound effect overlapping the bubble is not one), else its ink.
  const letteringIn = (r: (typeof regions)[number], owner?: Box, others: Box[] = [], anchor?: Box): Box | null => {
    // Two bubbles drawn joined are one white shape holding two texts: each
    // text takes the blocks of lettering closest to it (page pixels).
    const dist = (b: Box, t: Box) => Math.hypot(b.x + b.w / 2 - (t.x + t.w / 2) * scale, b.y + b.h / 2 - (t.y + t.h / 2) * scale);
    const mine = blocks
      .map((b) => ({ x: b.x * scale, y: b.y * scale, w: b.w * scale, h: b.h * scale }))
      .filter((b) => {
        const cx = b.x + b.w / 2;
        const cy = b.y + b.h / 2;
        return cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h;
      })
      .filter((b) => !owner || others.every((o) => dist(b, owner) <= dist(b, o)));
    // Alone in its shape: the lettering under the text read, and what lies
    // within about a line of it. The tips of a spiky rim and the text of a
    // bubble joined below were taken in: the translation went up onto the
    // spikes, or down between the two bubbles.
    let near: number | undefined;
    if (!owner && anchor && mine.length > 1) {
      const a = { x: anchor.x * scale, y: anchor.y * scale, w: anchor.w * scale, h: anchor.h * scale };
      const gap = (p: Box, q: Box) => Math.max(0, Math.max(p.x, q.x) - Math.min(p.x + p.w, q.x + q.w), Math.max(p.y, q.y) - Math.min(p.y + p.h, q.y + q.h));
      let kept = mine.filter((b) => gap(b, a) === 0);
      if (kept.length === 0) {
        const d = (b: Box) => Math.hypot(b.x + b.w / 2 - (a.x + a.w / 2), b.y + b.h / 2 - (a.y + a.h / 2));
        kept = [mine.reduce((best, b) => (d(b) < d(best) ? b : best))];
      }
      const letters = letterHeight(px, kept[0], r.tinted) || Math.min(...kept.map((b) => b.h));
      const reach = Math.max(10 * scale, letters * 1.6);
      near = reach;
      for (let grew = true; grew; ) {
        grew = false;
        const u = {
          x: Math.min(...kept.map((b) => b.x)),
          y: Math.min(...kept.map((b) => b.y)),
          w: Math.max(...kept.map((b) => b.x + b.w)) - Math.min(...kept.map((b) => b.x)),
          h: Math.max(...kept.map((b) => b.y + b.h)) - Math.min(...kept.map((b) => b.y)),
        };
        for (const b of mine) {
          if (kept.includes(b) || gap(b, u) > reach) continue;
          kept.push(b);
          grew = true;
        }
      }
      if (kept.length < mine.length) mine.splice(0, mine.length, ...kept);
    }
    // Shared shape: the whole ink of the shape is the other text's too.
    const ink = owner && others.length > 0 ? null : maskedCrop(px, r).ink;
    if (mine.length === 0) return ink;
    let x0 = Math.min(...mine.map((b) => b.x));
    let y0 = Math.min(...mine.map((b) => b.y));
    let x1 = Math.max(...mine.map((b) => b.x + b.w));
    let y1 = Math.max(...mine.map((b) => b.y + b.h));
    // Marks the blocks left out ("I…" at the start of a line, a lone "?")
    // stayed visible beside the translation: the ink of the bubble completes
    // the box, unless it is far bigger (a drawn effect crossing the bubble).
    // (Up to 6 times: lines the blocks missed, at the ends of lines or a whole
    // line, stayed in English around a translation lettered too small.)
    if (ink && ink.w * ink.h <= (x1 - x0) * (y1 - y0) * 6 && ink.h <= (y1 - y0) * 5 && ink.x < x1 && ink.x + ink.w > x0 && ink.y < y1 && ink.y + ink.h > y0) {
      // Alone in its shape, only up to about a line past the lettering kept
      // above: the ink of a bubble joined below took the box down again.
      const lim = near ?? Infinity;
      x0 = Math.min(x0, Math.max(ink.x, x0 - lim));
      y0 = Math.min(y0, Math.max(ink.y, y0 - lim));
      x1 = Math.max(x1, Math.min(ink.x + ink.w, x1 + lim));
      y1 = Math.max(y1, Math.min(ink.y + ink.h, y1 + lim));
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };
  // A box a little off its bubble (the model misplaced it): moved into the
  // nearest bubble that has no text of its own, instead of being lettered
  // over the artwork while the bubble stays untranslated.
  const claimed = new Set(found.map((t) => t.region).filter(Boolean));
  for (const t of found) {
    if (t.region) continue;
    // Free models sometimes place a box a bubble's height away (on a shirt,
    // on a sound effect): a bubble holding untranslated lettering up to
    // about half a page width away is taken, if its lettering is about the
    // size of the text read.
    const reach = Math.max(t.box.h * 1.5, W * 0.55);
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
      if (gap >= reach || gap >= bestGap) continue;
      const ink = maskedCrop(px, r).ink;
      // Only bubbles that really hold lettering, of a size close to the text read.
      if (!ink) continue;
      const ratio = ink.w / scale / Math.max(1, t.box.w);
      if (gap > W * 0.08 && (ratio < 0.4 || ratio > 2.5)) continue;
      best = r;
      bestGap = gap;
    }
    if (best) {
      t.region = best;
      claimed.add(best);
    }
  }
  // Two bubbles drawn joined, read by the model as ONE item: their blocks of
  // lettering lie apart in the shape, and the whole translation was lettered
  // across both. The translation is cut at the sentence end closest to the
  // share of letters of each block, one item per block.
  // So are two bubbles drawn apart but touching, both under the model's
  // box ("I HAVE TO BE ON THE PHONE…" and "I'LL EAT THE REST…" lettered as
  // one text across both): the blocks of lettering under the box, each in
  // its own bubble.
  for (const t of [...found]) {
    if (t.region && found.some((o) => o !== t && o.region === t.region)) continue;
    const r = t.region;
    const inShape = (b: Box) => {
      if (!r) return false;
      const cx = (b.x + b.w / 2) * scale;
      const cy = (b.y + b.h / 2) * scale;
      return cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h;
    };
    const inBox = (b: Box) => {
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      const m = t.model ?? t.box;
      return cx >= m.x && cx <= m.x + m.w && cy >= m.y && cy <= m.y + m.h && overlapShare(b, m) > 0.8;
    };
    const own = blocks.filter((b) => inShape(b) || inBox(b)).sort((a, b) => a.y - b.y);
    if (own.length < 2) continue;
    // Groups of blocks with a clear gap between them (more than two lines).
    const groups: Box[] = [];
    for (const b of own) {
      const g = groups[groups.length - 1];
      // About a line (blocks hold several: a block's height took a gap of
      // 67 px between two bubbles for line spacing).
      const line = Math.min(b.h, g?.h ?? b.h, W * 0.03);
      const otherShape = g && inRegion(g.x + g.w / 2, g.y + g.h / 2) !== inRegion(b.x + b.w / 2, b.y + b.h / 2);
      if (g && !otherShape && b.y - (g.y + g.h) < Math.max(line, 12) * 2) {
        const x1 = Math.max(g.x + g.w, b.x + b.w);
        const y1 = Math.max(g.y + g.h, b.y + b.h);
        g.x = Math.min(g.x, b.x);
        g.w = x1 - g.x;
        g.h = y1 - g.y;
      } else groups.push({ ...b });
    }
    if (groups.length !== 2) continue;
    // The model's box over both halves: a text tied to a bubble far above
    // it is not that bubble's other half.
    if (groups.some((g) => overlapShare(g, t.model ?? t.box) < 0.3)) continue;
    // A group on another text's place (a white page taken for one shape)
    // would letter a half over that text.
    if (groups.some((g) => found.some((o) => o !== t && overlapShare(g, o.box) > 0.2))) continue;
    // Each half in its own bubble when they are two; none claimed by another text.
    const regionsOf = groups.map((g) => inRegion(g.x + g.w / 2, g.y + g.h / 2) ?? r);
    if (regionsOf.some((q) => q && q !== r && found.some((o) => o !== t && o.region === q))) continue;
    if (!r && regionsOf.some((q) => !q)) continue;
    const parts = splitAtSentence(t.f.translation, (groups[0].w * groups[0].h) / (groups[0].w * groups[0].h + groups[1].w * groups[1].h));
    const texts = splitAtSentence(t.f.text, (groups[0].w * groups[0].h) / (groups[0].w * groups[0].h + groups[1].w * groups[1].h));
    if (!parts || !texts) continue;
    found.splice(
      found.indexOf(t),
      1,
      ...groups.map((g, k) => ({ ...t, f: { ...t.f, text: texts[k], translation: parts[k] }, box: { ...g }, block: { ...g }, region: regionsOf[k] })),
    );
    logInfo('ocr', 'Bulles soudées lues d’un bloc par l’IA : traduction répartie entre les deux', { texte: t.f.text.slice(0, 40) });
  }
  // One bubble read twice (overlapping slices, or split by the model): the
  // most complete reading is kept, never two translations on top of each other.
  const byRegion = new Map<unknown, Found>();
  const kept: Found[] = [];
  for (const t of found) {
    if (t.region) {
      const prev = byRegion.get(t.region);
      // The same text read twice (overlapping slices): the most complete one.
      // A different text in the same white shape (two bubbles drawn joined)
      // is kept: it was dropped and its bubble stayed untranslated.
      const same = prev && (similarText(prev.f.text, t.f.text) || overlapShare(prev.box, t.box) > 0.5);
      if (!prev) {
        byRegion.set(t.region, t);
        kept.push(t);
      } else if (!same) {
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
  const pageInCaps = cased.length >= 2 && capitals / cased.length >= 0.6;

  // Texts outside bubbles (signs, screens, chats) are put back on their
  // letters, so the repaired background covers the original instead of
  // sitting beside it.
  const outside = kept.filter((t) => !t.region);
  for (const t of outside) {
    const s = snapToText(px, { x: t.box.x * scale, y: t.box.y * scale, w: t.box.w * scale, h: t.box.h * scale });
    // Then over the lines of the same text the box left out (they stayed
    // visible under the translation).
    // A block of lettering found on the page already spans its lines: not
    // spread sideways (over hair beside it: the tilted band of the erase was
    // then too thin, and the last line stayed).
    // On plain paper (no hair to spread over): the ends of lines the block
    // left out are taken ("To be continue|d" stayed beside the translation).
    const isBlock = t.block && Math.abs(t.block.x - t.box.x) < 1 && Math.abs(t.block.w - t.box.w) < 1;
    const onPaper = isBlock && plainPaper(px, s, letterHeight(px, s) || s.h * 0.5) !== null;
    const g = growToText(px, { x: s.x, y: s.y, w: s.w, h: s.h }, !isBlock || onPaper);
    t.box.x = g.x / scale;
    t.box.y = g.y / scale;
    t.box.w = g.w / scale;
    t.box.h = g.h / scale;
  }
  // A translation over the wrong place is worse than none: the original
  // stays as drawn when the text landed on a bubble that has its own text,
  // or when several of them cover each other (the slanted, tightly packed
  // lines of a game chat or of a phone screen).
  const skipped = new Set<Found>();
  for (const t of outside) {
    const onBubble = kept.some((k) => {
      if (!k.region) return false;
      const r = k.region;
      return overlapShare(t.box, { x: r.x / scale, y: r.y / scale, w: r.w / scale, h: r.h / scale }) > 0.3;
    });
    if (onBubble) skipped.add(t);
  }
  for (const [i, a] of outside.entries()) {
    for (const b of outside.slice(i + 1)) {
      if (overlapShare(a.box, b.box) > 0.25) {
        skipped.add(a);
        skipped.add(b);
      }
    }
  }
  if (skipped.size > 0) logInfo('ocr', `Texte(s) hors bulle laissé(s) tel(s) quel(s) : placement incertain`, { textes: skipped.size });

  const bubbles: Bubble[] = [];
  for (const t of kept) {
    if (skipped.has(t)) continue;
    const { f, box } = t;
    let region = t.region;
    const original = pageInCaps && region ? f.text.toLocaleUpperCase() : f.text;
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    const lines = Math.max(1, f.text.split('\n').length);
    const vertical = box.h > box.w * 1.6;
    const siblings = region ? kept.filter((k) => k !== t && k.region === region && !skipped.has(k)).map((k) => k.box) : [];
    let ink = region ? letteringIn(region, siblings.length ? box : undefined, siblings, t.block ?? box) : null;
    // The lettering found in the "bubble" is elsewhere than the text: a light
    // background joined to another bubble was taken for this text's bubble,
    // and the translation went over that other bubble. It is lettering on
    // the artwork.
    if (region && ink && overlapShare(t.block ?? box, { x: ink.x / scale, y: ink.y / scale, w: ink.w / scale, h: ink.h / scale }) < 0.2) {
      region = undefined;
      ink = null;
      // Put back on its own letters, as the other texts on the artwork.
      const g = growToText(px, snapToText(px, { x: box.x * scale, y: box.y * scale, w: box.w * scale, h: box.h * scale }));
      Object.assign(box, { x: g.x / scale, y: g.y / scale, w: g.w / scale, h: g.h / scale });
    }
    // A bubble (or a blank stretch of paper taken for one) with no lettering
    // at all: the model made the text up, often a line continuing the story
    // so far. It was lettered over blank paper.
    if (region && siblings.length === 0 && !t.block && !withInk(region)) {
      logInfo('ocr', 'Texte ignoré : aucune écriture à cet endroit de la page', { texte: f.text.slice(0, 40) });
      continue;
    }
    if (region && ink && !vertical) {
      // Without the bubble's tail taken with the letters.
      ink = trimStrokes(px, ink);
      // In a bubble: sized on the real letters, erased within the bubble's shape.
      const inkBox = { x: ink.x / scale, y: ink.y / scale, w: ink.w / scale, h: ink.h / scale };
      // The size of the original letters, measured on the page: the model
      // rarely says how many lines a bubble has, and a size guessed from
      // the height of the whole block lettered some bubbles twice too big.
      // Capitals are about 0.7 of the font size and the layout may go up
      // to 1.2 times this size: the translation ends up as big as the original.
      let letters = letterHeight(px, ink, region.tinted) / scale;
      const chars = Math.max(1, f.text.replace(/\s+/g, ' ').trim().length);
      // The bubble's rim, or a drawing, in the box: one run as tall as it.
      // Not a text on one line ("IF…"), as tall as its box (it was then
      // measured at a third of its size).
      const oneLine = letters * 0.55 * chars <= inkBox.w * 1.4;
      if (letters > inkBox.h * 0.6 && inkBox.h > 24 && !oneLine) {
        letters = letterHeightByEdges(px, ink) / scale;
        if (letters < inkBox.h * 0.12) letters = 0;
      }
      // Never bigger than the text can be in its box.
      const fitting = Math.max(8, Math.sqrt((inkBox.w * inkBox.h) / (chars * 0.6 * 1.2)));
      const fontSize = Math.max(
        8,
        Math.min(60, fitting * 1.3, letters > 0 ? letters / LETTERS_TO_FONT : Math.min(inkBox.h / (lines * 1.2), W * 0.03, fitting)),
      );
      const fill = regionFill(px, region);
      const look = lookOfText(px, inkBox, scale, fontSize, true);
      // Dark lettering is black: a watermark crossing it tinted the sample.
      if (!region.tinted && look.color) {
        const [r, g, b] = [1, 3, 5].map((k) => parseInt(look.color!.slice(k, k + 2), 16));
        if ((r * 299 + g * 587 + b * 114) / 1000 < 128) look.color = '#111111';
      }
      // Lettering barely different from the bubble it is written in: its
      // colour was measured against the drawing around a small bubble (grey
      // shading), the bubble's white taken for the letters, and the
      // translation was written white on white. Black or white for the
      // bubble then.
      if (look.color) {
        const lum = (hex: string) => {
          const v = parseInt(hex.slice(1), 16);
          return (((v >> 16) & 255) * 299 + ((v >> 8) & 255) * 587 + (v & 255) * 114) / 1000;
        };
        if (Math.abs(lum(look.color) - lum(fill)) < 90) look.color = contrastColor(fill);
      }
      const pad = Math.max(2, fontSize * 0.5) * scale;
      let patch: string | undefined;
      let patchBox: Box | undefined;
      try {
        const cleaned = cleanBubble(px, region, { x: ink.x - pad, y: ink.y - pad, w: ink.w + pad * 2, h: ink.h + pad * 2 }, fill, fontSize * scale * 1.8);
        patch = pixelsToCanvas(cleaned.pixels).toDataURL('image/jpeg', 0.92);
        patchBox = { x: cleaned.x / scale, y: cleaned.y / scale, w: cleaned.pixels.width / scale, h: cleaned.pixels.height / scale };
      } catch {
        /* flat fill instead */
      }
      let area: Box | undefined;
      const inner = innerBox(region, (inkBox.x + inkBox.w / 2) * scale, (inkBox.y + inkBox.h / 2) * scale, inkBox.h * scale);
      if (inner.w > 0) area = { x: inner.x / scale, y: inner.y / scale, w: inner.w / scale, h: inner.h / scale };
      if (area) {
        // The translation stays around the place of the original lettering,
        // with room to grow: the widest area found in the bubble reached
        // past a grainy rim, and the text ran out of the bubble.
        const roomW = inkBox.w * 1.5 + fontSize * 2;
        const roomH = inkBox.h * 1.8 + fontSize * 1.6;
        const mx = inkBox.x + inkBox.w / 2;
        const my = inkBox.y + inkBox.h / 2;
        const x0 = Math.max(area.x, mx - roomW / 2);
        const y0 = Math.max(area.y, my - roomH / 2);
        const x1 = Math.min(area.x + area.w, mx + roomW / 2);
        const y1 = Math.min(area.y + area.h, my + roomH / 2);
        area = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      }
      if (area && siblings.length > 0) {
        // Its own lobe of a joined shape: not past half way to another text.
        const my = inkBox.y + inkBox.h / 2;
        for (const o of siblings) {
          const oy = o.y + o.h / 2;
          const mid = (my + oy) / 2;
          if (oy > my && area.y + area.h > mid) area = { ...area, h: Math.max(0, mid - area.y) };
          if (oy < my && area.y < mid) area = { ...area, y: mid, h: Math.max(0, area.y + area.h - mid) };
        }
      }
      if (area && area.w * area.h < inkBox.w * inkBox.h * 0.6) area = undefined;
      // The bubble's own shape, within its lobe of a joined shape.
      let top = region.y / scale;
      let bottom = (region.y + region.h) / scale;
      const my = inkBox.y + inkBox.h / 2;
      for (const o of siblings) {
        const oy = o.y + o.h / 2;
        if (oy > my) bottom = Math.min(bottom, (my + oy) / 2);
        else top = Math.max(top, (my + oy) / 2);
      }
      const shape = bubbleShape(region, scale, top, bottom, Math.max(2, fontSize * 0.35), px, inkBox);
      bubbles.push({
        id: uid(),
        ...inkBox,
        area,
        shape,
        original,
        translation: f.translation,
        ...voiceOf(f),
        vertical,
        fontSize,
        fill,
        color: look.color,
        patch,
        patchBox,
        caps: pageInCaps || undefined,
      });
      continue;
    }
    let area: Box | undefined;
    if (region) {
      const inner = innerBox(region, cx * scale, cy * scale, box.h * scale);
      if (inner.w > 0) area = { x: inner.x / scale, y: inner.y / scale, w: inner.w / scale, h: inner.h / scale };
      if (area && area.w * area.h < box.w * box.h * 0.6) area = undefined;
    }
    // The size of the original letters, measured on the page when they can
    // be (a model's box says nothing of the number of lines: a three-line
    // text was lettered twice too big over the drawing); else from the box,
    // whose lines are ~1.2× the letters.
    const scaledBox = { x: box.x * scale, y: box.y * scale, w: box.w * scale, h: box.h * scale };
    let measured = vertical ? 0 : letterHeight(px, scaledBox) / scale;
    // Over the artwork, or with a bubble's rim in the box, every row holds
    // dark pixels: one run as tall as the box, not a letter. The lines are
    // then told apart by their letter edges.
    const charsHere = Math.max(1, f.text.replace(/\s+/g, ' ').trim().length);
    if (measured > box.h * 0.6 && box.h > 24 && measured * 0.55 * charsHere > box.w * 1.4) {
      measured = letterHeightByEdges(px, scaledBox) / scale;
      // Slanted lines overlap rows: bits of letters, not lines.
      if (measured < box.h * 0.12) measured = 0;
    }
    // The text must fit in its box: letters about 0.6 of their size wide,
    // lines 1.2 of it apart.
    const chars = Math.max(1, f.text.replace(/\s+/g, ' ').trim().length);
    const fitting = Math.sqrt((box.w * box.h) / (chars * 0.6 * 1.2));
    const fontSize =
      measured > 0
        ? Math.max(8, Math.min(60, measured / LETTERS_TO_FONT, Math.max(10, fitting * 1.3)))
        : Math.max(10, Math.min(60, (vertical ? box.w : box.h) / (lines * 1.2), fitting));
    // Lettering drawn on the artwork keeps its style: the tilt and the slant
    // of its lines (a shout written aslant, italic handwriting), and the
    // colours of its letters and of their outline.
    const scaled = { x: box.x * scale, y: box.y * scale, w: box.w * scale, h: box.h * scale };
    const rotation = area || vertical ? 0 : boxSkew(px, scaled);
    const slant = area || vertical ? 0 : boxSlant(px, scaled, rotation);
    // On plain paper (a bubble open on one side, a line on the white between
    // panels): erased with the paper's colour, which leaves nothing behind.
    const paperFill = !area && !vertical && !rotation ? plainPaper(px, scaled, fontSize * scale) : null;
    const paper = paperFill !== null;
    // The paper's room around the letters (the inside of a bubble that was
    // not found), row by row and a little in from its edges: the
    // translation follows it as it would a bubble's shape.
    let paperRows: Bubble['shape'];
    if (paperFill) {
      const room = paperShape(px, scaled, paperFill, Math.max(scaled.w, scaled.h) * 0.4);
      const inset = Math.max(2, fontSize * 0.35);
      if (room) {
        const x = room.spans.flatMap(([l, r]) => [Math.round(l / scale + inset), Math.round(r / scale - inset)]);
        const widest = Math.max(...room.spans.map(([l, r]) => r - l)) / scale;
        if (widest > box.w * 0.9) paperRows = { y: room.y / scale, step: room.step / scale, x, inset };
      }
    }
    // Lettering on the artwork: the whole letters the box cuts, and those
    // right beside them, are taken off (the first "O" and the dots of a
    // tilted "OWW, MY BACK…" stayed beside the translation).
    if (!paperFill && !area && !vertical) {
      const g = growToLetters(px, scaled, fontSize * LETTERS_TO_FONT * scale);
      Object.assign(box, { x: g.x / scale, y: g.y / scale, w: g.w / scale, h: g.h / scale });
    }
    const look = lookOfText(px, box, scale, fontSize, Boolean(area) || paper, rotation);
    if (paperFill) {
      // Erased like the inside of a bubble: the letters and their soft
      // edges take the paper's colour, a bubble's outline crossing the box stays.
      try {
        const pad = Math.max(3, fontSize * scale * 0.3);
        const hex = '#' + paperFill.map((v) => v.toString(16).padStart(2, '0')).join('');
        // On paper the ends of the longest lines may stick out of the box
        // (the "T" and "G" of "THOUGHT OF TOUCHING" stayed beside the French).
        const g = growToText(px, scaled, true);
        const x0 = Math.min(scaled.x, g.x) - pad;
        const y0 = Math.min(scaled.y, g.y) - pad;
        const x1 = Math.max(scaled.x + scaled.w, g.x + g.w) + pad;
        const y1 = Math.max(scaled.y + scaled.h, g.y + g.h) + pad;
        const cleaned = cleanPaper(px, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, hex, fontSize * scale * 1.8);
        look.patch = pixelsToCanvas(cleaned.pixels).toDataURL('image/jpeg', 0.92);
        look.patchBox = { x: cleaned.x / scale, y: cleaned.y / scale, w: cleaned.pixels.width / scale, h: cleaned.pixels.height / scale };
        look.fill = hex;
      } catch {
        /* the flat fill instead */
      }
    }
    // No lettering could be taken off the artwork there: the model placed
    // its box where there is no text. Nothing is lettered over the drawing.
    if (!region && !look.patch && !look.covered && !paper) {
      logInfo('ocr', 'Texte hors bulle ignoré : aucun lettrage à cet endroit', { texte: f.text.slice(0, 40) });
      continue;
    }
    bubbles.push({
      id: uid(),
      ...box,
      area,
      original,
      translation: f.translation,
      ...voiceOf(f),
      vertical,
      fontSize,
      shape: paperRows,
      fill: look.fill,
      outline: look.outline || undefined,
      color: look.color,
      outlineColor: look.outline ? look.outlineColor : undefined,
      rotation: rotation || undefined,
      slant: slant || undefined,
      // With room around it, the French may take more than the English did
      // (also in a bubble whose inside was not found: "T'ES COMPLÈTEMENT
      // TARÉE" was written tiny in the box of three short English lines).
      roomy: (!region || !area) && plainAround(px, scaled) ? true : undefined,
      patch: look.patch,
      patchBox: look.patchBox,
    });
  }
  return evenCutText(withoutDrawnShouts(bubbles, H), H);
}

/**
 * One or two words lettered on the artwork in letters far bigger than the
 * page's dialogue: a drawn sound effect the model translated anyway
 * ("DU-DOOM" became "BOUM-BOUM" on a grey card). Left as drawn.
 */
export function withoutDrawnShouts(bubbles: Bubble[], H: number): Bubble[] {
  const usual = usualFontSize(bubbles.filter((b) => b.area || b.shape), H);
  return bubbles.filter((b) => {
    if (b.area || b.shape || !b.fontSize) return true;
    const words = b.original.replace(/[-‐–—~]+/g, '').trim().split(/\s+/).filter((w) => /\p{L}/u.test(w));
    if (words.length > 2) return true;
    if (isSoundEffect(b.original.replace(/[-‐–—~]+/g, ' '))) return false;
    return !(usual && b.fontSize > usual * 1.6);
  });
}

/**
 * The inside of a bubble row by row, in page pixels, `inset` pixels in from
 * its rim, between `top` and `bottom` (its own lobe of a joined shape).
 * Undefined for a shape too small to say anything.
 */
export function bubbleShape(region: BubbleRegion, scale: number, top: number, bottom: number, inset: number, px?: Pixels, ink?: Box): Bubble['shape'] {
  const step = Math.max(1, Math.round(region.h / 48));
  const rows: [number, number][] = [];
  let first = -1;
  for (let r = 0; r < region.h; r += step) {
    const y = (region.y + r) / scale;
    // The narrowest of the rows this one stands for: the spikes of a shouted
    // bubble's rim point inward between the rows kept, and the lines of the
    // translation ran onto their tips.
    let minX = region.spans[r * 2];
    let maxX = region.spans[r * 2 + 1];
    for (let rr = Math.max(0, r - Math.floor(step / 2)); rr <= Math.min(region.h - 1, r + Math.ceil(step / 2)); rr++) {
      const a = region.spans[rr * 2];
      const b = region.spans[rr * 2 + 1];
      if (a < 0 || minX < 0) continue;
      minX = Math.max(minX, a);
      maxX = Math.min(maxX, b);
    }
    if (maxX < minX) minX = -1;
    const inBand = y >= top + inset * 0.6 && y <= bottom - inset * 0.6;
    let left = minX / scale + inset;
    let right = maxX / scale - inset;
    // Drawing inside the bubble's white beside the text (a sound effect
    // whose white letters join the bubble's): the room stops at its first
    // dark line, scanned outward from the text.
    if (px && ink && minX >= 0) {
      const py = region.y + r;
      const dark = (x: number) => {
        const i = (py * px.width + x) * 4;
        return px.data[i] * 0.299 + px.data[i + 1] * 0.587 + px.data[i + 2] * 0.114 < 100;
      };
      // Rows of the text: from a little outside its letters (started on its
      // edge, the "I" of "IF…" was taken for a line of the drawing and the
      // bubble's room cut in half).
      const inkRows = y >= ink.y - inset && y <= ink.y + ink.h + inset;
      const margin = Math.max(4, inset);
      const from0 = Math.round((inkRows ? ink.x - margin : ink.x + ink.w / 2) * scale);
      const from1 = Math.round((inkRows ? ink.x + ink.w + margin : ink.x + ink.w / 2) * scale);
      for (let x = Math.max(minX, from1); x <= maxX; x++) {
        if (dark(x)) {
          right = Math.min(right, x / scale - inset);
          break;
        }
      }
      for (let x = Math.min(maxX, from0); x >= minX; x--) {
        if (dark(x)) {
          left = Math.max(left, x / scale + inset);
          break;
        }
      }
    }
    if (minX < 0 || !inBand || right - left < inset) {
      if (first >= 0) rows.push([0, -1]);
      continue;
    }
    if (first < 0) first = r;
    rows.push([Math.round(left), Math.round(right)]);
  }
  // Rows past the last usable one are not kept.
  while (rows.length && rows[rows.length - 1][1] < rows[rows.length - 1][0]) rows.pop();
  if (first < 0 || rows.length < 3) return undefined;
  // The colour of the rim: the darkest pixel just past the interior, row by row.
  let rim: string | undefined;
  if (px) {
    const lums: [number, number, number, number][] = [];
    for (let r = 0; r < region.h; r += step) {
      const maxX = region.spans[r * 2 + 1];
      if (maxX < 0) continue;
      let best: [number, number, number, number] | null = null;
      for (let x = maxX + 1; x <= Math.min(px.width - 1, maxX + 5); x++) {
        const i = ((region.y + r) * px.width + x) * 4;
        const l = px.data[i] * 0.299 + px.data[i + 1] * 0.587 + px.data[i + 2] * 0.114;
        if (!best || l < best[0]) best = [l, px.data[i], px.data[i + 1], px.data[i + 2]];
      }
      if (best) lums.push(best);
    }
    // Among the darkest of the rim (a thin outline blends with the paper
    // around it: the median came out brown on a beige wall).
    lums.sort((a, b) => a[0] - b[0]);
    const m = lums[Math.floor(lums.length / 5)];
    if (m && m[0] < 140) rim = '#' + m.slice(1).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  }
  const whole = top <= region.y / scale + 1 && bottom >= (region.y + region.h) / scale - 1;
  // The top and bottom of the bubble's body: rows at least a third as wide
  // as its widest one (not the tip of its tail).
  let widest = 0;
  for (let r = 0; r < region.h; r++) if (region.spans[r * 2] >= 0) widest = Math.max(widest, region.spans[r * 2 + 1] - region.spans[r * 2]);
  const inBody = (r: number) => region.spans[r * 2] >= 0 && region.spans[r * 2 + 1] - region.spans[r * 2] >= widest / 3;
  let r0 = 0;
  while (r0 < region.h - 1 && !inBody(r0)) r0++;
  let r1 = region.h - 1;
  while (r1 > r0 && !inBody(r1)) r1--;
  const body: number[] = [];
  let last: [number, number] | null = null;
  for (let r = r0; r <= r1; r += step) {
    if (body.length >= 400) break;
    const row: [number, number] | null = region.spans[r * 2] >= 0 ? [region.spans[r * 2], region.spans[r * 2 + 1]] : last;
    if (!row) continue;
    last = row;
    body.push(Math.round(row[0] / scale), Math.round(row[1] / scale));
  }
  return { y: Math.round((region.y + first) / scale), step: step / scale, x: rows.flat(), inset, rim, whole, body, bodyY: Math.round((region.y + r0) / scale) };
}

/** The speaker fields a bubble keeps (only those the model gave). */
function voiceOf(f: { speaker?: string; gender?: 'male' | 'female'; kind?: Bubble['kind'] }): Pick<Bubble, 'speaker' | 'gender' | 'kind'> {
  const out: Pick<Bubble, 'speaker' | 'gender' | 'kind'> = {};
  if (f.speaker) out.speaker = f.speaker;
  if (f.gender) out.gender = f.gender;
  if (f.kind) out.kind = f.kind;
  return out;
}

/** Median lettering size of the texts not cut by the page edge (undefined if none). */
function usualFontSize(bubbles: Bubble[], H: number): number | undefined {
  const sizes = bubbles
    .filter((b) => b.y > H * 0.01 && b.y + b.h < H * 0.99 && b.fontSize)
    .map((b) => b.fontSize!)
    .sort((a, b) => a - b);
  return sizes.length ? sizes[Math.floor(sizes.length / 2)] : undefined;
}

/**
 * A line cut by the page edge measures half its height: its translation
 * came out in tiny letters. Such texts take the usual size of the page.
 */
export function evenCutText(bubbles: Bubble[], H: number): Bubble[] {
  const usual = usualFontSize(bubbles, H);
  if (!usual) return bubbles;
  return bubbles.map((b) => {
    const cut = b.y <= H * 0.01 || b.y + b.h >= H * 0.99;
    return cut && b.fontSize && b.fontSize < usual * 0.75 ? { ...b, fontSize: usual } : b;
  });
}

/**
 * Cuts a text in two at the sentence end ("…", ".", "!", "?") closest to
 * `share` of its length. Null when there is no sentence end to cut at.
 */
export function splitAtSentence(text: string, share: number): [string, string] | null {
  const t = text.replace(/\s+/g, ' ').trim();
  const target = t.length * share;
  let best = -1;
  let bestD = Infinity;
  for (const m of t.matchAll(/[.!?…»"]+\s+(?=\S)/g)) {
    const at = (m.index ?? 0) + m[0].length;
    const d = Math.abs(at - target);
    if (d < bestD && at > t.length * 0.15 && at < t.length * 0.85) {
      bestD = d;
      best = at;
    }
  }
  if (best < 0) return null;
  return [t.slice(0, best).trim(), t.slice(best).trim()];
}

/** Two readings of one text: equal once letters are compared, or one contains the other. */
function similarText(a: string, b: string): boolean {
  const norm = (t: string) => t.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return x === y;
  return x === y || (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x)));
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
    // Each half is joined once: two pieces of this page matched with the same
    // half on the next one lettered two translations on top of each other.
    const used = new Set<(typeof starts)[number]>();
    for (const a of cut) {
      // Same bubble: its two halves line up across the break.
      const b = starts.find((r) => {
        if (used.has(r)) return false;
        const overlap = Math.min(a.x + a.w, r.x + r.w) - Math.max(a.x, r.x);
        return overlap > Math.min(a.w, r.w) * 0.6;
      });
      if (!b) continue;
      used.add(b);
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
      const answer = await withRetries(() => visionTranslate(image, aiSource(chapter), chapter.targetLang, signal, undefined, size, context, chapter.layout), signal);
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
      // Letters measured on both halves; a line cut by the break measures
      // only its top or bottom: then the usual size of the page is taken.
      const upperInk = maskedCrop(bottomPx, a).ink;
      const lowerInk = maskedCrop(topPx, b).ink;
      const letters = Math.max(upperInk ? letterHeight(bottomPx, upperInk, a.tinted) : 0, lowerInk ? letterHeight(topPx, lowerInk, b.tinted) : 0);
      const lineCut = (upperInk && upperInk.y + upperInk.h >= stripH - 3) || (lowerInk && lowerInk.y <= 2);
      const usual = usualFontSize(bubbles, H);
      let fontSize = letters > 0 ? Math.max(8, Math.min(60, letters / LETTERS_TO_FONT)) : (usual ?? W * 0.026);
      if (usual && (lineCut || fontSize < usual * 0.6)) fontSize = Math.max(fontSize, usual);
      const half = (px: typeof bottomPx, r: typeof a, dy: number): Pick<Bubble, 'x' | 'y' | 'w' | 'h' | 'patch' | 'patchBox'> => {
        const ink = maskedCrop(px, r).ink;
        if (!ink) return { x: r.x + r.w / 2, y: dy + r.y + r.h / 2, w: 1, h: 1 };
        try {
          // The whole half is cleaned: a line set apart from the others
          // (the last line of the bubble) stayed under the translation.
          const cleaned = cleanBubble(px, r, { x: r.x, y: r.y, w: r.w, h: r.h }, fill);
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
      const shared = { original, translation, ...voiceOf(items[0]), fontSize, fill, color: contrastColor(fill) };
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
        // The same text already lettered there by the next page's own reading
        // (pages read two at a time, the next pair sometimes done first): it
        // stayed, squeezed in a corner of the bubble, beside the joined one.
        const kept = fresh.bubbles.filter(
          (x) =>
            x.seam !== 'prev' &&
            !zones.some((z) => coversCentre(z, x) || overlapShare(z, x) > 0.3) &&
            !continued.some((l) => similarText(l.original, x.original) || similarText(l.translation, x.translation)),
        );
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
      .map((b) => `${b.speaker ? `[${b.speaker}] ` : ''}${b.original.replace(/\s+/g, ' ').trim()} → ${b.translation.replace(/\s+/g, ' ').trim()}`)
      .slice(-CONTEXT_LINES);
    // The characters met so far in the series, so that the same person keeps
    // the same label (and so the same voice when read aloud).
    const cast = charactersFor(chapter.title);
    const parts = [
      ...(lines.length > 0 ? [lines.join('\n')] : []),
      ...(cast ? [`Characters of the series so far (reuse these exact labels in "speaker" for the same people):\n${cast}`] : []),
    ];
    return parts.length > 0 ? parts.join('\n\n') : undefined;
  } catch {
    return undefined;
  }
}

export function visionEnabled(): boolean {
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

/** Tallest stretch of the strip read in one request without being sliced, in widths. */
const GROUP_MAX_RATIO = 2.65;

/** Tallest stretch allowed when no empty band comes sooner (read in two overlapping slices). */
const GROUP_STRETCH_RATIO = 4;

// --- The chapter as one strip, cut between panels ------------------------------
//
// Sites cut a webtoon into images of a fixed height (800×1045…), anywhere:
// through a bubble, between two lines of a text. The pages are put back end
// to end as one strip, and the strip is cut again where nothing is drawn
// across the whole width (the white space between panels), so that each
// stretch read by the AI holds whole bubbles and whole texts.

/** A part of a page drawn in a stretch of the strip. */
export interface Segment {
  page: Page;
  /** First row of the part in the page. */
  srcY: number;
  /** Where it is drawn in the stretch. */
  dstY: number;
  h: number;
}

/** A stretch of the strip read by one request. */
export interface Chunk {
  segments: Segment[];
  width: number;
  height: number;
}

/** How many pixels of each row stand out from the row's own colour: 0 across a gutter. */
export function rowBusy(px: Pixels): Uint16Array {
  const { data, width: W, height: H } = px;
  const out = new Uint16Array(H);
  const samples: number[] = new Array(9);
  for (let y = 0; y < H; y++) {
    const row = y * W * 4;
    for (let k = 0; k < 9; k++) samples[k] = luminance(data, row + Math.floor(((k + 0.5) * W) / 9) * 4);
    samples.sort((a, b) => a - b);
    const ref = samples[4];
    let n = 0;
    for (let x = 0; x < W; x++) if (Math.abs(luminance(data, row + x * 4) - ref) > 40) n++;
    out[y] = n;
  }
  return out;
}

/** Stretches no taller than this many widths are read in one request. */
const CHUNK_RATIO = 2.6;

/**
 * Where to cut the strip of `pages` (all of width `W`, with the busy rows of
 * each): in the middle of bands of empty rows taller than a line spacing (a
 * gap between two lines of one text is not one), each stretch as tall as
 * allowed. Without such a band, a stretch up to four widths (read in two
 * overlapping slices), else a cut at the quietest row.
 */
export function planChunks(pages: { page: Page; busy: Uint16Array }[], W: number): Chunk[] {
  const starts: number[] = [];
  let total = 0;
  for (const p of pages) {
    starts.push(total);
    total += p.busy.length;
  }
  const busyAt = (y: number) => {
    let i = starts.length - 1;
    while (i > 0 && starts[i] > y) i--;
    return pages[i].busy[y - starts[i]] ?? 0;
  };
  const band = Math.max(12, Math.round(W * 0.03));
  const cuts: number[] = [];
  let run = -1;
  for (let y = 0; y <= total; y++) {
    const empty = y < total && busyAt(y) <= 1;
    if (empty && run < 0) run = y;
    if (!empty && run >= 0) {
      if (y - run >= band && run > 0 && y < total) cuts.push(Math.round((run + y) / 2));
      run = -1;
    }
  }
  const chunks: Chunk[] = [];
  const make = (a: number, b: number): Chunk => {
    const segments: Segment[] = [];
    pages.forEach((p, i) => {
      const y0 = Math.max(a, starts[i]);
      const y1 = Math.min(b, starts[i] + p.busy.length);
      if (y1 > y0) segments.push({ page: p.page, srcY: y0 - starts[i], dstY: y0 - a, h: y1 - y0 });
    });
    return { segments, width: W, height: b - a };
  };
  let s = 0;
  while (total - s > W * GROUP_MAX_RATIO) {
    const lo = s + W * 0.8;
    const hi = s + W * CHUNK_RATIO;
    let cut = [...cuts].reverse().find((c) => c > lo && c <= hi);
    if (cut === undefined) cut = cuts.find((c) => c > hi && c <= s + W * GROUP_STRETCH_RATIO);
    if (cut === undefined) {
      // No empty band: the quietest row of the last part of the stretch.
      let best = Math.round(hi);
      for (let y = Math.round(s + W * 1.8); y <= hi; y++) if (busyAt(y) < busyAt(best)) best = y;
      cut = best;
    }
    chunks.push(make(s, cut));
    s = cut;
  }
  chunks.push(make(s, total));
  return chunks;
}

/** A page's image, read again from storage when iOS lost the bytes held in memory. */
async function decodePage(p: Page): Promise<DecodedImage> {
  try {
    return await decodeImage(p.blob);
  } catch {
    const fresh = await getPage(p.id);
    if (!fresh) throw new Error(`Image de la page ${p.index + 1} illisible`);
    p.blob = fresh.blob;
    return decodeImage(fresh.blob);
  }
}

/** The busy rows of each page (each decoded once). */
async function stripProfiles(pages: Page[], signal: AbortSignal): Promise<Uint16Array[]> {
  const out: Uint16Array[] = [];
  for (const p of pages) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const bitmap = await decodePage(p);
    try {
      out.push(rowBusy(bitmapPixels(bitmap)));
    } finally {
      bitmap.close();
    }
  }
  return out;
}

/** One stretch of the strip read by the AI; the texts of each page, in its own coordinates. */
async function processChunk(chunk: Chunk, chapter: Chapter, signal: AbortSignal): Promise<Map<string, Bubble[]>> {
  const settings = getSettings();
  const { width: W, height: H, segments } = chunk;
  const canvas = createCanvas(W, H);
  const c = context2d(canvas);
  for (const sg of segments) {
    const bitmap = await decodePage(sg.page);
    try {
      c.drawImage(bitmap.source, 0, sg.srcY, bitmap.width, sg.h, 0, sg.dstY, W, sg.h);
    } finally {
      bitmap.close();
    }
  }
  const joined: DecodedImage = { source: canvas, width: W, height: H, close: () => (canvas.width = canvas.height = 0) };
  const start = performance.now();
  const first = segments[0].page;
  const last = segments[segments.length - 1].page;
  const context = await storySoFar(chapter, first.index);
  let all: Bubble[];
  try {
    all = await visionPage(joined, chapter, signal, context, { group: true });
  } finally {
    joined.close();
  }
  const per = new Map<string, Bubble[]>(segments.map((sg) => [sg.page.id, []]));
  for (const b of all) {
    // Everything drawn for it: its letters, the room of its bubble, the repaired patch.
    const parts = [b, b.area, b.patchBox, b.shape && { y: b.shape.y, h: (b.shape.x.length / 2) * b.shape.step }].filter(Boolean) as { y: number; h: number }[];
    const top = Math.min(...parts.map((p) => p.y));
    const bottom = Math.max(...parts.map((p) => p.y + p.h));
    const hit = segments.filter((sg) => bottom > sg.dstY && top < sg.dstY + sg.h);
    if (hit.length === 0) continue;
    // Within one page: whole. Across a break between two images of the
    // site: on each, the upper part carrying the text, the others only erasing.
    hit.forEach((sg, k) => {
      const here = shiftBubble(b, sg.srcY - sg.dstY);
      if (hit.length === 1) per.get(sg.page.id)!.push(here);
      else per.get(sg.page.id)!.push({ ...here, id: k === 0 ? b.id : uid(), seam: k === 0 ? 'next' : 'prev' });
    });
  }
  const pagesText = first.index === last.index ? `Page ${first.index + 1}` : `Pages ${first.index + 1} à ${last.index + 1}`;
  logInfo('ocr', `${pagesText} : passage lu par l’IA, coupé entre les cases : ${all.length} texte(s)`, {
    taille: `${W}×${H}`,
    de: `${first.index + 1}:${segments[0].srcY}`,
    à: `${last.index + 1}:${segments[segments.length - 1].srcY + segments[segments.length - 1].h}`,
    modèle: settings.llm.model,
    ms: since(start),
  });
  return per;
}

/** A bubble moved up or down (page coordinates), with everything placed on the page. */
function shiftBubble(b: Bubble, dy: number): Bubble {
  if (!dy) return { ...b };
  return {
    ...b,
    y: b.y + dy,
    area: b.area ? { ...b.area, y: b.area.y + dy } : undefined,
    patchBox: b.patchBox ? { ...b.patchBox, y: b.patchBox.y + dy } : undefined,
    shape: b.shape ? { ...b.shape, y: b.shape.y + dy } : undefined,
  };
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
    let refused = false;
    if (useVision) {
      const context = await storySoFar(chapter, page.index);
      let bubbles: Bubble[];
      try {
        bubbles = await visionPage(bitmap, chapter, signal, context);
      } catch (err) {
        // The provider's content filter refuses this image: the page is read
        // on the device instead and only its texts are sent to translate,
        // rather than staying in English.
        if (!(err instanceof TranslateError) || !err.message.startsWith(CONTENT_REFUSED)) throw err;
        logWarn('ocr', `Page ${page.index + 1} refusée par le filtre de contenu de l’IA : lecture sur l’appareil à la place`, where);
        refused = true;
        bubbles = [];
      }
      if (!refused) {
      try {
        bubbles = await stitchSeam(page, bitmap, chapter, signal, bubbles, context);
      } catch (err) {
        if ((err as Error).name === 'AbortError') throw err;
        logWarn('ocr', `Bulle à cheval sur la page ${page.index + 2} non recollée : ${(err as Error).message.slice(0, 120)}`);
      }
      // The end of a bubble begun on the previous page is already lettered.
      const own = (await getPage(page.id))?.bubbles.filter((b) => b.seam === 'prev') ?? [];
      if (own.length > 0) bubbles = [...bubbles.filter((b) => !own.some((o) => coversCentre(visiblePart(o, bitmap.height), b) || similarText(o.original, b.original))), ...own];
      logInfo('ocr', `Page ${page.index + 1} lue par l’IA : ${bubbles.length} texte(s)`, {
        ...where,
        modèle: settings.llm.model,
        ms: since(start),
      });
      await patchPage(page.id, { bubbles, status: 'done', stalled: 0 });
      rememberSpeakers(chapter.title, bubbles);
      return 'llm';
      }
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
  /** Only proofread the translations of the pages. */
  proofreadOnly?: boolean;
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
/** Lines proofread per request: the context of a few pages, an answer kept short. */
const PROOFREAD_BATCH = 60;

/** Proofreads the translations of some pages of a chapter and saves the fixes. */
export async function proofreadChapter(
  chapter: Chapter,
  pageIds: string[],
  signal: AbortSignal,
  /** Proofread in the background while pages are still translated: no progress shown. */
  quiet = false,
): Promise<number> {
  const pages = (await getPages(chapter.id)).filter((p) => pageIds.includes(p.id) && p.status === 'done').sort((a, b) => a.index - b.index);
  const lines: { page: string; bubble: string; id: number; original: string; text: string; speaker?: string; gender?: string }[] = [];
  for (const p of pages) {
    for (const b of p.bubbles) {
      // A line the reader wrote stays theirs.
      // The end of a cut bubble follows its start (fixed with it below).
      if (b.hidden || b.edited || b.seam === 'prev' || !b.original.trim() || !/\p{L}/u.test(b.translation)) continue;
      lines.push({
        page: p.id,
        bubble: b.id,
        id: lines.length + 1,
        original: b.original,
        text: b.translation,
        speaker: b.speaker && !/^(narrator|sign)$/i.test(b.speaker) ? b.speaker : undefined,
        gender: b.gender,
      });
    }
  }
  let fixed = 0;
  let skipped = 0;
  // The provider's recommended model proofreads (text only, a few requests
  // a chapter): a small vision model chosen for speed wrote "j'ai faut",
  // "nu" for a woman, "ma matinée d'après", and let them through again.
  const main = getSettings().llm;
  const preset = LLM_PRESETS.find((x) => x.id === main.preset);
  // None chosen: the best text model the account still has (NVIDIA retires
  // models without notice; the one named here before answered "410 Gone").
  const gone = new Set<string>();
  const picked = main.proofModel?.trim() ? undefined : await proofModelFor(main).catch(() => undefined);
  let llm = { ...main, model: main.proofModel?.trim() || picked || preset?.model || main.model };
  if (llm.model !== main.model) logInfo('job', `Relecture par ${llm.model}`);
  // A batch the provider refuses (the content filter on an explicit scene,
  // an answer cut short): halved and asked again, so that one scene does not
  // keep the whole chapter from being proofread.
  const ask = async (batch: typeof lines): Promise<Map<number, string>> => {
    try {
      return await withRetries(() => proofreadTexts(batch, chapter.targetLang, signal, llm), signal, [4000]);
    } catch (err) {
      if (signal.aborted) throw err;
      // The proofreading model is not on this account (or keeps failing):
      // the main model proofreads instead.
      if (llm.model !== main.model && (err instanceof TranslateError ? err.fatal || !err.retryable || /HTTP 4\d\d/.test(err.message) : true) && !/HTTP 429/.test((err as Error).message) && !(err as Error).message.startsWith(CONTENT_REFUSED)) {
        // A model chosen for the account and since retired: the next best one.
        if (picked && !main.proofModel?.trim()) {
          gone.add(llm.model);
          forgetProofModel();
          const next = await proofModelFor(main, gone).catch(() => undefined);
          if (next && !gone.has(next)) {
            logWarn('job', `Relecture : ${llm.model} indisponible (${(err as Error).message.slice(0, 80)}), relecture par ${next}`);
            llm = { ...main, model: next };
            return ask(batch);
          }
        }
        logWarn('job', `Relecture : ${llm.model} indisponible (${(err as Error).message.slice(0, 80)}), relecture par ${main.model}`);
        llm = main;
        return ask(batch);
      }
      if (err instanceof TranslateError && err.fatal) throw err;
      if (batch.length <= 6) {
        skipped += batch.length;
        logWarn('job', `Relecture : ${batch.length} ligne(s) non relue(s) : ${(err as Error).message.slice(0, 120)}`);
        return new Map();
      }
      const half = Math.ceil(batch.length / 2);
      const a = await ask(batch.slice(0, half));
      const b = await ask(batch.slice(half));
      return new Map([...a, ...b]);
    }
  };
  for (let k = 0; k < lines.length; k += PROOFREAD_BATCH) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const batch = lines.slice(k, k + PROOFREAD_BATCH);
    if (!quiet) setJob(chapter.id, { message: `Relecture des traductions… ${Math.min(lines.length, k + batch.length)}/${lines.length}` });
    const fixes = await ask(batch);
    if (fixes.size === 0) continue;
    const byPage = new Map<string, Map<string, string>>();
    for (const l of batch) {
      const t = fixes.get(l.id);
      if (!t) continue;
      if (!byPage.has(l.page)) byPage.set(l.page, new Map());
      byPage.get(l.page)!.set(l.bubble, t);
      logInfo('job', `Relu : « ${l.text.slice(0, 50)} » → « ${t.slice(0, 50)} »`);
    }
    // The end of a cut bubble, on the next page, takes the same fix.
    for (const [pageId, changes] of [...byPage]) {
      const p = pages.find((q) => q.id === pageId);
      const nextPage = p && (await getPages(chapter.id)).find((q) => q.index === p.index + 1);
      if (!p || !nextPage) continue;
      for (const [bubbleId, text] of changes) {
        const start = p.bubbles.find((b) => b.id === bubbleId);
        if (start?.seam !== 'next') continue;
        const end = nextPage.bubbles.find((b) => b.seam === 'prev' && b.original === start.original);
        if (!end) continue;
        if (!byPage.has(nextPage.id)) byPage.set(nextPage.id, new Map());
        byPage.get(nextPage.id)!.set(end.id, text);
      }
    }
    for (const [pageId, changes] of byPage) {
      // Saved on the latest copy of the page (the reader may have edited it meanwhile).
      const fresh = await getPage(pageId);
      if (!fresh) continue;
      const bubbles = fresh.bubbles.map((b) => {
        const t = changes.get(b.id);
        if (!t || b.edited) return b;
        fixed++;
        return { ...b, translation: t };
      });
      await patchPage(pageId, { bubbles });
    }
  }
  logInfo('job', `Relecture de « ${chapter.title} » : ${fixed} correction(s) sur ${lines.length} ligne(s)${skipped ? `, ${skipped} non relue(s)` : ''}`);
  return fixed;
}

export function startChapter(chapterId: string, opts: StartOptions = {}): Promise<void> {
  if (isRunning(chapterId)) return Promise.resolve();
  const controller = new AbortController();
  controllers.set(chapterId, controller);
  // Chapters are processed one after the other (the AI's rate limits and the
  // phone's memory are shared): a second one waits its turn, and says so.
  setJob(chapterId, { running: true, queued: true, done: 0, failed: 0, total: 0, phase: 'idle', message: undefined, pageIndex: null });
  const run = ocrQueue.then(async () => {
    setJob(chapterId, { queued: false });
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
    let stopped = false;
    // AI reading: two pages at once. A page mostly waits for the provider
    // (3 to 30 s an answer), so the chapter takes about half the time; the
    // pace of requests stays under the provider's limit (see paceRequest).
    const parallel = visionEnabled() && !opts.translateOnly ? PAGE_PARALLEL : 1;
    let nextPage = 0;
    // Short pages read by the AI two or three at a time (one request).
    // AI reading: the pages put back end to end and cut again between panels
    // (see planChunks), each stretch read by one request.
    type Unit = { page: Page } | { chunk: Chunk };
    let units: Unit[] = todo.map((page) => ({ page }));
    const pending = new Map<string, { bubbles: Bubble[]; need: number; got: number }>();
    const solo = new Set<string>();
    if (parallel > 1 && todo.length > 0) {
      setJob(chapterId, { message: 'Préparation des pages…' });
      try {
        const runs: Page[][] = [];
        for (const p of todo) {
          const run = runs[runs.length - 1];
          const tail = run?.[run.length - 1];
          if (run && tail!.index + 1 === p.index && Math.abs(p.width - run[0].width) <= 2) run.push(p);
          else runs.push([p]);
        }
        const planned: Unit[] = [];
        for (const run of runs) {
          // One page of an ordinary height: read as it is (with its neighbours joined if a bubble crosses).
          if (run.length === 1 && run[0].height <= run[0].width * GROUP_MAX_RATIO) {
            planned.push({ page: run[0] });
            continue;
          }
          const busy = await stripProfiles(run, controller.signal);
          for (const chunk of planChunks(run.map((page, i) => ({ page, busy: busy[i] })), run[0].width)) planned.push({ chunk });
        }
        units = planned;
        for (const u of units) {
          if (!('chunk' in u)) continue;
          for (const sg of u.chunk.segments) {
            const a = pending.get(sg.page.id) ?? { bubbles: [], need: 0, got: 0 };
            a.need++;
            pending.set(sg.page.id, a);
          }
        }
        const nChunks = units.filter((u) => 'chunk' in u).length;
        logInfo('job', `Chapitre recollé en une bande et recoupé entre les cases : ${nChunks} passage(s) pour ${todo.length} page(s)`);
      } catch (err) {
        if ((err as Error).name === 'AbortError') throw err;
        logWarn('job', `Découpage entre les cases impossible, pages lues une à une : ${(err as Error).message.slice(0, 120)}`);
        units = todo.map((page) => ({ page }));
        pending.clear();
      }
      setJob(chapterId, { message: undefined });
    }
    const doUnit = async (unit: Unit): Promise<'next' | 'stop'> => {
      if ('page' in unit) return doPage(unit.page);
      const pages = unit.chunk.segments.map((sg) => sg.page).filter((p) => !solo.has(p.id));
      if (pages.length === 0) return 'next';
      setJob(chapterId, { pageIndex: pages[0].index, phase: 'ocr' });
      for (const p of pages) if (p.status !== 'ocr') await patchPage(p.id, { status: 'ocr', error: undefined });
      try {
        const per = await processChunk(unit.chunk, chapter, controller.signal);
        for (const p of pages) {
          const a = pending.get(p.id)!;
          a.bubbles.push(...(per.get(p.id) ?? []));
          a.got++;
          if (a.got < a.need) continue;
          await patchPage(p.id, { bubbles: a.bubbles, status: 'done', stalled: 0 });
          rememberSpeakers(chapter.title, a.bubbles);
          done++;
        }
        setJob(chapterId, { done, engine: 'llm', message: undefined });
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          for (const p of pages) await patchPage(p.id, { status: 'pending' });
          return 'stop';
        }
        if (err instanceof TranslateError && err.fatal) {
          for (const p of pages) await patchPage(p.id, { status: 'pending', error: undefined });
          logError('job', `Traduction arrêtée à la page ${pages[0].index + 1} : ${(err as Error).message}`, { chapitre: chapter.title });
          setJob(chapterId, { message: (err as Error).message });
          stopped = true;
          return 'stop';
        }
        // Read page by page instead (a refusal of the content filter, an
        // answer that never came…): each page then takes its own way.
        logWarn('job', `Pages ${pages[0].index + 1} à ${pages[pages.length - 1].index + 1} lues une à une : ${(err as Error).message.slice(0, 120)}`);
        for (const p of pages) {
          if (pending.get(p.id)!.got >= pending.get(p.id)!.need) continue;
          solo.add(p.id);
          if ((await doPage(p)) === 'stop') return 'stop';
        }
        return 'next';
      }
      await refreshStats(chapterId);
      return 'next';
    };
    const doPage = async (page: Page): Promise<'next' | 'stop'> => {
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
          return 'stop';
        }
        const message = (err as Error).message || String(err);
        if (err instanceof TranslateError && err.fatal) {
          // The next pages would be refused the same way: they wait, untouched.
          await patchPage(page.id, { status: page.bubbles.length ? 'done' : 'pending', error: undefined });
          logError('job', `Traduction arrêtée à la page ${page.index + 1} : ${message}`, { chapitre: chapter.title });
          setJob(chapterId, { message });
          stopped = true;
          return 'stop';
        }
        failed++;
        logError('job', `Page ${page.index + 1} en erreur : ${message}`, { chapitre: chapter.title });
        await patchPage(page.id, { status: 'error', error: message });
        setJob(chapterId, { failed, message });
      }
      await refreshStats(chapterId);
      return 'next';
    };
    // The translations read again by the AI as the chapter goes (typos and
    // words left untranslated, which the reading of one image lets through):
    // a batch as soon as enough lines are done in a row, the rest at the
    // end. Done only at the end, a chapter read or exported meanwhile kept
    // its mistakes ("JE CRYAIS", fixed half a minute after the export).
    const proofreads = !opts.proofreadOnly && (visionEnabled() || st.provider === 'llm');
    const proofed = new Set<string>();
    let proofing: Promise<unknown> = Promise.resolve();
    const proofreadSoFar = async (last: boolean): Promise<number> => {
      const ids = new Set(todo.map((p) => p.id));
      const fresh = (await getPages(chapterId)).filter((p) => ids.has(p.id) && !proofed.has(p.id)).sort((a, b) => a.index - b.index);
      const batch: string[] = [];
      let lines = 0;
      for (const p of fresh) {
        // In reading order, up to the first page not done yet.
        if (p.status !== 'done' && p.status !== 'error') {
          if (last) continue;
          break;
        }
        batch.push(p.id);
        lines += p.bubbles.filter((b) => b.translation.trim() && b.seam !== 'prev').length;
      }
      if (batch.length === 0 || (!last && lines < PROOFREAD_BATCH)) return 0;
      batch.forEach((id) => proofed.add(id));
      return proofreadChapter(chapter, batch, controller.signal, !last);
    };
    const startedAt = Date.now();
    const worker = async (n: number) => {
      while (nextPage < units.length && !controller.signal.aborted && !stopped) {
        // The provider refused a request for going too fast: one page at a
        // time from then on (two at once only made both wait, refused).
        if (n > 0 && lastRateLimitAt() >= startedAt) return;
        const unit = units[nextPage++];
        if ((await doUnit(unit)) === 'stop') return;
        if (proofreads && nextPage < units.length)
          proofing = proofing.then(() =>
            proofreadSoFar(false).catch((err) => {
              if ((err as Error).name !== 'AbortError') logWarn('job', `Relecture en cours de route non faite : ${(err as Error).message.slice(0, 120)}`);
            }),
          );
      }
    };
    if (opts.proofreadOnly) done = todo.length;
    else await Promise.all(Array.from({ length: Math.min(parallel, todo.length) }, (_, n) => worker(n)));
    await proofing;
    if (done > 0 && !controller.signal.aborted && !stopped && (visionEnabled() || st.provider === 'llm')) {
      setJob(chapterId, { phase: 'translate', pageIndex: null, message: 'Relecture des traductions…' });
      try {
        const fixed = opts.proofreadOnly ? await proofreadChapter(chapter, todo.map((p) => p.id), controller.signal) : await proofreadSoFar(true);
        setJob(chapterId, { message: opts.proofreadOnly ? `Relecture faite : ${fixed} correction(s)` : undefined });
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          logWarn('job', `Relecture non faite : ${(err as Error).message.slice(0, 120)}`);
          setJob(chapterId, { message: `Relecture non faite : ${(err as Error).message.slice(0, 80)}` });
        }
      }
    }
    await refreshStats(chapterId);
    logInfo('job', `Fin de « ${chapter.title} » : ${done} page(s) faite(s), ${failed} en erreur${controller.signal.aborted || stopped ? ', arrêté' : ''}`, {
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
