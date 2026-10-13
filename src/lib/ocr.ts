import { createWorker, type Worker } from 'tesseract.js';
import { bitmapPixels, pixelsToCanvas } from './image';
import { detectBubbles, innerBox, maskedCrop, sampleBackground, type BubbleRegion, type Pixels } from './imageproc';
import { sourceLanguage, type SourceLanguage } from './languages';
import {
  classifyScript,
  cleanLine,
  dedupeBlocks,
  groupLines,
  guessLatinLanguage,
  isMeaningful,
  joinLines,
  scriptStats,
  type Box,
  type LangRules,
  type OcrLine,
} from './text';

/** A text block found on a page, before translation. */
export interface DetectedText {
  box: Box;
  area?: Box;
  text: string;
  confidence: number;
  vertical: boolean;
  fontSize: number;
  fill: string;
  outline: boolean;
}

type StatusFn = (message: string, progress?: number) => void;
let statusListener: StatusFn | null = null;

/** Receives model download / OCR progress messages. */
export function setOcrStatusListener(fn: StatusFn | null): void {
  statusListener = fn;
}

// --- Tesseract workers ------------------------------------------------------

interface ManagedWorker {
  worker: Promise<Worker>;
  queue: Promise<unknown>;
}

const workers = new Map<string, ManagedWorker>();

function managed(lang: string): ManagedWorker {
  let entry = workers.get(lang);
  if (!entry) {
    const worker = createWorker(lang, 1 /* OEM.LSTM_ONLY */, {
      logger: (m) => {
        if (m.status && m.status.startsWith('loading') && statusListener) statusListener(m.status, m.progress);
      },
    });
    entry = { worker, queue: Promise.resolve() };
    workers.set(lang, entry);
    // Drop failed workers so the next call can retry (e.g. offline at first try).
    worker.catch(() => workers.delete(lang));
  }
  return entry;
}

/** Runs one recognition on a worker, serialised with other jobs on that worker. */
function recognize(lang: string, image: HTMLCanvasElement, psm: string) {
  const entry = managed(lang);
  const job = entry.queue.then(async () => {
    const worker = await entry.worker;
    await worker.setParameters({ tessedit_pageseg_mode: psm as never, preserve_interword_spaces: '1' });
    return worker.recognize(image, {}, { blocks: true, text: false });
  });
  entry.queue = job.catch(() => undefined);
  return job;
}

/** Stops a worker that is no longer needed (frees its memory). */
async function releaseWorker(lang: string): Promise<void> {
  const entry = workers.get(lang);
  if (!entry) return;
  workers.delete(lang);
  await entry.queue;
  (await entry.worker.catch(() => null))?.terminate();
}

export async function terminateOcr(): Promise<void> {
  const all = [...workers.values()];
  workers.clear();
  await Promise.all(all.map(async (w) => (await w.worker.catch(() => null))?.terminate()));
}

// --- helpers ------------------------------------------------------------------

type RawLine = OcrLine;

function linesOf(result: Awaited<ReturnType<typeof recognize>>, scale: number, dx: number, dy: number): RawLine[] {
  const out: RawLine[] = [];
  for (const block of result.data.blocks ?? []) {
    for (const para of block.paragraphs) {
      for (const line of para.lines) {
        out.push({
          x: line.bbox.x0 / scale + dx,
          y: line.bbox.y0 / scale + dy,
          w: (line.bbox.x1 - line.bbox.x0) / scale,
          h: (line.bbox.y1 - line.bbox.y0) / scale,
          text: line.text,
          confidence: line.confidence,
        });
      }
    }
  }
  return out;
}

function keepLines(lines: RawLine[], rules: LangRules, minConfidence: number): RawLine[] {
  return lines
    .map((l) => ({ ...l, text: cleanLine(l.text, rules) }))
    .filter((l) => l.confidence >= minConfidence && isMeaningful(l.text, rules));
}

function unionBox(boxes: Box[]): Box {
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

function rulesFor(lang: SourceLanguage): LangRules {
  return { script: lang.script, noSpaces: lang.noSpaces };
}

interface RecognizedText {
  text: string;
  confidence: number;
  lines: RawLine[];
  vertical: boolean;
}

/** OCRs a small image (one bubble / one box), trying the likely orientation first. */
async function recognizeBlock(
  canvas: HTMLCanvasElement,
  lang: SourceLanguage,
  preferVertical: boolean,
  minConfidence: number,
  scale: number,
  dx: number,
  dy: number,
): Promise<RecognizedText | null> {
  const rules = rulesFor(lang);
  const modes: { vertical: boolean }[] = [];
  const canVertical = lang.tesseract.length > 1;
  if (canVertical && preferVertical) modes.push({ vertical: true }, { vertical: false });
  else {
    modes.push({ vertical: false });
    if (canVertical) modes.push({ vertical: true });
  }
  let best: RecognizedText | null = null;
  for (const mode of modes) {
    const tessLang = mode.vertical ? lang.tesseract[1] : lang.tesseract[0];
    const result = await recognize(tessLang, canvas, mode.vertical ? '5' : '6');
    const lines = keepLines(linesOf(result, scale, dx, dy), rules, minConfidence);
    if (lines.length === 0) continue;
    const text = joinLines(
      lines.map((l) => l.text),
      rules,
    );
    const weight = lines.reduce((s, l) => s + l.text.length, 0) || 1;
    const confidence = lines.reduce((s, l) => s + l.confidence * l.text.length, 0) / weight;
    const candidate = { text, confidence, lines, vertical: mode.vertical };
    if (!best || candidate.confidence > best.confidence) best = candidate;
    if (confidence >= 75) break;
  }
  return best;
}

function fontSizeOf(lines: RawLine[], vertical: boolean): number {
  return median(lines.map((l) => (vertical ? l.w : l.h))) || 20;
}

function backgroundFor(px: Pixels, box: Box, scale: number) {
  return sampleBackground(px, { x: box.x * scale, y: box.y * scale, w: box.w * scale, h: box.h * scale }, 3);
}

// --- page OCR -----------------------------------------------------------------

export interface PageOcrOptions {
  minConfidence: number;
  signal?: AbortSignal;
}

const MAX_PIXELS = 12_000_000;
const TILE = 2400;
const OVERLAP = 200;

/**
 * Finds and reads every piece of text on a page.
 * 1. speech bubbles are detected and read one by one (most reliable);
 * 2. a sparse-text pass over the page catches captions, narration boxes and
 *    text that is not inside a white bubble.
 */
export async function ocrPage(bitmap: ImageBitmap, sourceCode: string, opts: PageOcrOptions): Promise<DetectedText[]> {
  const lang = sourceLanguage(sourceCode);
  const rules = rulesFor(lang);
  const W = bitmap.width;
  const H = bitmap.height;
  // Work on a downscaled copy for huge pages to keep memory reasonable.
  const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (W * H)));
  const px = bitmapPixels(bitmap, scale);
  const found: DetectedText[] = [];
  const claimed: Box[] = [];

  // 1. Speech bubbles.
  const regions = detectBubbles(px)
    .sort((a, b) => b.ink - a.ink)
    .slice(0, 60);
  for (const region of regions) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const crop = maskedCrop(px, region);
    const canvas = pixelsToCanvas(crop.pixels);
    const preferVertical = Boolean(lang.vertical) && region.inkBox.h > region.inkBox.w * 1.15;
    const res = await recognizeBlock(canvas, lang, preferVertical, opts.minConfidence, scale, crop.x / scale, crop.y / scale);
    if (!res) continue;
    // Erase every dark pixel enclosed by the bubble (OCR boxes miss periods, dots…).
    const ink = region.inkBox;
    const box = unionBox([...res.lines, { x: ink.x / scale, y: ink.y / scale, w: ink.w / scale, h: ink.h / scale }]);
    const center = { x: (box.x + box.w / 2) * scale, y: (box.y + box.h / 2) * scale };
    const inner = innerBox(region, center.x, center.y, box.h * scale);
    const area =
      inner.w > 0 ? { x: inner.x / scale, y: inner.y / scale, w: inner.w / scale, h: inner.h / scale } : undefined;
    const bg = backgroundFor(px, box, scale);
    found.push({
      box,
      area: area && area.w * area.h >= box.w * box.h * 0.6 ? area : undefined,
      text: res.text,
      confidence: res.confidence,
      vertical: res.vertical,
      fontSize: fontSizeOf(res.lines, res.vertical),
      fill: bg.fill,
      outline: false,
    });
    claimed.push(regionBox(region, scale));
  }

  // 2. Sparse text pass, tile by tile.
  const lines: RawLine[] = [];
  const tileH = Math.round(TILE * scale);
  const overlap = Math.round(OVERLAP * scale);
  for (let top = 0; top < px.height; top += tileH - overlap) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const h = Math.min(tileH, px.height - top);
    const tile = pixelsToCanvas(slicePixels(px, top, h));
    const result = await recognize(lang.tesseract[0], tile, '11');
    const isFirst = top === 0;
    const isLast = top + h >= px.height;
    const ownTop = isFirst ? 0 : top + overlap / 2;
    const ownBottom = isLast ? px.height : top + h - overlap / 2;
    for (const line of linesOf(result, 1, 0, top)) {
      const cy = line.y + line.h / 2;
      if (cy < ownTop || cy >= ownBottom) continue;
      lines.push({ ...line, x: line.x / scale, y: line.y / scale, w: line.w / scale, h: line.h / scale });
    }
    if (isLast) break;
  }
  const free = keepLines(lines, rules, opts.minConfidence).filter(
    (l) => !claimed.some((c) => contains(c, l.x + l.w / 2, l.y + l.h / 2)),
  );
  for (const block of groupLines(free, rules)) {
    let text = block.text;
    let confidence = block.confidence;
    let vertical = block.vertical;
    let lineBoxes: RawLine[] = block.lines;
    // Vertical manga text is misread by horizontal models: read the box again.
    if (lang.vertical && block.h > block.w * 1.3) {
      const pad = Math.round(Math.max(block.w, 12) * 0.25);
      const crop = clampBox({ x: block.x - pad, y: block.y - pad, w: block.w + pad * 2, h: block.h + pad * 2 }, W, H);
      const canvas = pixelsToCanvas(bitmapPixels(bitmap, 1, crop));
      const res = await recognizeBlock(canvas, lang, true, opts.minConfidence, 1, crop.x, crop.y);
      if (res) {
        text = res.text;
        confidence = res.confidence;
        vertical = res.vertical;
        lineBoxes = res.lines;
      }
    }
    if (!isMeaningful(text, rules)) continue;
    const box = { x: block.x, y: block.y, w: block.w, h: block.h };
    const bg = backgroundFor(px, box, scale);
    found.push({
      box,
      text,
      confidence,
      vertical,
      fontSize: fontSizeOf(lineBoxes, vertical),
      fill: bg.fill,
      outline: bg.uniformity < 0.6,
    });
  }

  return dedupeBlocks(found.map((f) => ({ ...f, ...f.box }))).map(({ x: _x, y: _y, w: _w, h: _h, ...rest }) => rest);
}

/** Reads the text inside a box drawn by the user. */
export async function ocrRegion(
  bitmap: ImageBitmap,
  box: Box,
  sourceCode: string,
  minConfidence: number,
): Promise<{ text: string; confidence: number; vertical: boolean; fill: string; fontSize: number } | null> {
  const lang = sourceLanguage(sourceCode);
  const crop = clampBox(box, bitmap.width, bitmap.height);
  // Small lettering is read better when enlarged.
  const scale = Math.min(3, Math.max(1, 900 / Math.max(crop.w, crop.h)));
  const px = bitmapPixels(bitmap, scale, crop);
  const canvas = pixelsToCanvas(px);
  const preferVertical = Boolean(lang.vertical) && crop.h > crop.w * 1.2;
  const res = await recognizeBlock(canvas, lang, preferVertical, Math.min(minConfidence, 30), scale, crop.x, crop.y);
  if (!res) return null;
  const bg = sampleBackground(px, { x: 2, y: 2, w: px.width - 4, h: px.height - 4 }, 1);
  return {
    text: res.text,
    confidence: res.confidence,
    vertical: res.vertical,
    fill: bg.fill,
    fontSize: fontSizeOf(res.lines, res.vertical),
  };
}

function regionBox(region: BubbleRegion, scale: number): Box {
  return { x: region.x / scale, y: region.y / scale, w: region.w / scale, h: region.h / scale };
}

function contains(b: Box, x: number, y: number): boolean {
  return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
}

function clampBox(b: Box, W: number, H: number): Box {
  const x = Math.max(0, Math.round(b.x));
  const y = Math.max(0, Math.round(b.y));
  return { x, y, w: Math.max(1, Math.min(W - x, Math.round(b.w))), h: Math.max(1, Math.min(H - y, Math.round(b.h))) };
}

function slicePixels(px: Pixels, top: number, height: number): Pixels {
  const start = top * px.width * 4;
  return { data: px.data.slice(start, start + height * px.width * 4), width: px.width, height };
}

// --- source language detection ---------------------------------------------------

/**
 * Models loaded together only to identify the script. They also read Latin
 * letters well enough; adding `eng` makes Tesseract fail to load a bogus
 * sub-language when combined with jpn / chi_sim.
 */
const DETECT_LANGS = 'kor+jpn+chi_sim';

function letterCount(text: string): number {
  return Object.values(scriptStats(text)).reduce((a, b) => a + b, 0);
}

function sampleText(result: Awaited<ReturnType<typeof recognize>>): string {
  return linesOf(result, 1, 0, 0)
    .filter((l) => l.confidence >= 50)
    .map((l) => l.text.trim())
    .join(' ');
}

/** Simplified or traditional: whichever model reads the samples with more confidence. */
async function chooseChinese(samples: HTMLCanvasElement[]): Promise<string> {
  let simplified = 0;
  let traditional = 0;
  for (const canvas of samples.slice(0, 3)) {
    const vertical = canvas.height > canvas.width * 1.15;
    const s = await recognizeBlock(canvas, sourceLanguage('zh-Hans'), vertical, 30, 1, 0, 0);
    const t = await recognizeBlock(canvas, sourceLanguage('zh-Hant'), vertical, 30, 1, 0, 0);
    simplified += s ? s.confidence * s.text.length : 0;
    traditional += t ? t.confidence * t.text.length : 0;
  }
  return traditional > simplified ? 'zh-Hant' : 'zh-Hans';
}

/**
 * Guesses the language of a page from its biggest speech bubbles (or from
 * the top of the page when there are none). Returns null if there is too
 * little text to decide.
 */
export async function detectPageLanguage(bitmap: ImageBitmap): Promise<string | null> {
  const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (bitmap.width * bitmap.height)));
  const px = bitmapPixels(bitmap, scale);
  const samples = detectBubbles(px)
    .sort((a, b) => b.ink - a.ink)
    .slice(0, 5)
    .map((r) => pixelsToCanvas(maskedCrop(px, r).pixels));
  let text = '';
  for (const canvas of samples) {
    text += ' ' + sampleText(await recognize(DETECT_LANGS, canvas, '6'));
    if (classifyScript(text) && letterCount(text) >= 20) break;
  }
  if (!classifyScript(text)) {
    // No usable bubble: read the top of the page as sparse text.
    const tile = pixelsToCanvas(slicePixels(px, 0, Math.min(px.height, Math.round(TILE * scale))));
    text += ' ' + sampleText(await recognize(DETECT_LANGS, tile, '11'));
  }
  const script = classifyScript(text);
  if (!script) return null;
  if (script === 'latin') return guessLatinLanguage(text);
  if (script === 'zh') return chooseChinese(samples);
  return script;
}

/** Frees the multi-language model once the language of a chapter is known. */
export function finishLanguageDetection(): Promise<void> {
  return releaseWorker(DETECT_LANGS);
}
