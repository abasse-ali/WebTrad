import { contrastColor } from './imageproc';
import { targetLanguage } from './languages';
import type { Bubble, FontId, LetterCase } from './types';
import type { Box } from './text';

export const FONTS: Record<FontId, { family: string; weight: number }> = {
  comic: { family: '"Comic Neue", "Comic Sans MS", "Chalkboard SE", "Noto Sans", sans-serif', weight: 700 },
  sans: { family: 'system-ui, "Segoe UI", Roboto, "Noto Sans", Arial, sans-serif', weight: 600 },
  serif: { family: 'Georgia, "Times New Roman", "Noto Serif", serif', weight: 600 },
};

export const LINE_HEIGHT = 1.12;

export interface LayoutOptions {
  font: FontId;
  letterCase: LetterCase;
  target: string;
}

export interface BubbleLayout {
  /** Rectangle painted with `fill` to hide the original lettering. */
  erase: Box;
  radius: number;
  /** Rectangle the translated lines are centred in (padding included). */
  area: Box;
  padding: number;
  fill: string;
  color: string;
  outline: boolean;
  fontSize: number;
  lines: string[];
  family: string;
  weight: number;
  rtl: boolean;
  /** Tilt in degrees, clockwise, around the centre of `area`. */
  rotation: number;
  align: 'left' | 'center' | 'right';
  /** Repaired artwork drawn over `erase` instead of a flat colour. */
  patch?: string;
}

let measureCtx: CanvasRenderingContext2D | null = null;
function ctx(): CanvasRenderingContext2D {
  if (!measureCtx) {
    const c = document.createElement('canvas');
    measureCtx = c.getContext('2d');
    if (!measureCtx) throw new Error('Canvas 2D unavailable');
  }
  return measureCtx;
}

type Measure = (s: string) => number;

const CLOSING = /^[!?:;»)\]}…,.%]+$/u;
const OPENING = /^[«(\[{¿¡]+$/u;

function segments(text: string, lang: string, noSpaces: boolean): string[] {
  if (!noSpaces) {
    // Keep French-style detached punctuation (« vas-tu ? ») with its word.
    const out: string[] = [];
    let pendingOpen = '';
    for (const token of text.split(/\s+/).filter(Boolean)) {
      if (CLOSING.test(token) && out.length) out[out.length - 1] += '\u00a0' + token;
      else if (OPENING.test(token)) pendingOpen += token + '\u00a0';
      else {
        out.push(pendingOpen + token);
        pendingOpen = '';
      }
    }
    if (pendingOpen) out.push(pendingOpen.trim());
    return out;
  }
  const Seg = (Intl as unknown as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (Seg) return [...new Seg(lang, { granularity: 'word' }).segment(text)].map((s) => s.segment);
  return [...text];
}

/**
 * Greedy line breaking. Words wider than the box are split, unless
 * `allowSplit` is false: then null is returned so a smaller size is tried.
 */
export function wrapText(text: string, maxWidth: number, measure: Measure, lang: string, noSpaces: boolean): string[];
export function wrapText(
  text: string,
  maxWidth: number,
  measure: Measure,
  lang: string,
  noSpaces: boolean,
  allowSplit: false,
): string[] | null;
export function wrapText(
  text: string,
  maxWidth: number,
  measure: Measure,
  lang: string,
  noSpaces: boolean,
  allowSplit = true,
): string[] | null {
  const sep = noSpaces ? '' : ' ';
  const lines: string[] = [];
  for (const paragraph of text.split(/\n+/)) {
    let line = '';
    for (const unit of segments(paragraph, lang, noSpaces)) {
      const candidate = line ? line + sep + unit : unit;
      if (measure(candidate.trim()) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line.trim()) lines.push(line.trim());
      if (measure(unit) <= maxWidth) {
        line = unit;
        continue;
      }
      if (!allowSplit) return null;
      // Word longer than the box: hard break by grapheme.
      line = '';
      const hyphen = noSpaces ? '' : '-';
      for (const ch of unit) {
        if (line && measure(line + ch + hyphen) > maxWidth) {
          lines.push(line + hyphen);
          line = '';
        }
        line += ch;
      }
    }
    if (line.trim()) lines.push(line.trim());
  }
  return lines;
}

/**
 * Evens out the lines of a wrapped text: the narrowest width that still
 * gives the same number of lines. Greedy wrapping fills the first lines and
 * leaves an orphan word on the last one ("…si / tard ?"); lettering reads
 * better as a compact, centred block.
 */
export function balanceLines(
  text: string,
  lines: string[],
  maxWidth: number,
  measure: Measure,
  lang: string,
  noSpaces: boolean,
): string[] {
  if (lines.length < 2) return lines;
  let best = lines;
  let lo = 0;
  let hi = Math.max(...lines.map(measure));
  for (let i = 0; i < 8 && hi - lo > 1; i++) {
    const mid = (lo + hi) / 2;
    const candidate = wrapText(text, Math.min(mid, maxWidth), measure, lang, noSpaces, false);
    if (candidate && candidate.length <= lines.length) {
      best = candidate;
      hi = mid;
    } else lo = mid;
  }
  return best;
}

/** Lettering written in capitals only, as most comics and scanlations are. */
export function isAllCaps(text: string): boolean {
  let cased = 0;
  let upper = 0;
  for (const ch of text) {
    const up = ch.toUpperCase();
    if (up === ch.toLowerCase()) continue; // digits, punctuation, scripts without case
    cased++;
    if (ch === up) upper++;
  }
  return cased >= 3 && upper / cased >= 0.8;
}

/** Translation size allowed for an original line box of height 1. */
const SIZE_RATIO = 1.2;
/**
 * The line box of capitals-only lettering is its cap height, about 0.7 em,
 * while the translation is set in mixed case: same factor on the real em size.
 */
const SIZE_RATIO_CAPS = 1.5;

function fits(lines: string[], size: number, box: { w: number; h: number }, measure: Measure): boolean {
  if (lines.length * size * LINE_HEIGHT > box.h) return false;
  return lines.every((l) => measure(l) <= box.w + 0.5);
}

function clampBox(b: Box, W: number, H: number): Box {
  const x = Math.max(0, b.x);
  const y = Math.max(0, b.y);
  return { x, y, w: Math.min(W, b.x + b.w) - x, h: Math.min(H, b.y + b.h) - y };
}

const cache = new Map<string, BubbleLayout | null>();

/** Computes where and how big the translation of a bubble is drawn. */
export function layoutBubble(b: Bubble, page: { width: number; height: number }, opts: LayoutOptions): BubbleLayout | null {
  const text = b.translation.trim();
  if (!text || b.hidden) return null;
  // Only OCR measures the line box itself; AI boxes include the line spacing.
  const capsSource = b.confidence !== undefined && isAllCaps(b.original);
  const key = JSON.stringify([b.x, b.y, b.w, b.h, b.area, text, b.fill, b.color, b.fontScale, b.fontSize, b.outline, opts, page.width, capsSource, b.rotation, b.align, b.patchBox, b.patch?.length]);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const target = targetLanguage(opts.target);
  const font = FONTS[opts.font] ?? FONTS.comic;
  // Same case as the source: scanlations lettered in capitals stay in capitals.
  const upper = opts.letterCase === 'upper' || (opts.letterCase === 'original' && isAllCaps(b.original));
  const display = upper && !target.noSpaces ? text.toLocaleUpperCase(opts.target) : text;
  const fill = b.fill ?? '#ffffff';
  const original = Math.max(8, b.fontSize ?? 22);

  let area: Box;
  let erase: Box;
  let radius: number;
  if (b.area) {
    area = b.area;
    // Rounded corners must not uncover the corners of the original lettering.
    radius = Math.min(8, Math.min(b.w, b.h) * 0.1);
    const pad = Math.max(3, original * 0.15) + radius * 0.45;
    erase = clampBox({ x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 }, page.width, page.height);
  } else {
    const padX = Math.min(b.w * 0.12, original * 0.6) + 3;
    const padY = Math.min(b.h * 0.12, original * 0.4) + 3;
    area = clampBox({ x: b.x - padX, y: b.y - padY, w: b.w + padX * 2, h: b.h + padY * 2 }, page.width, page.height);
    erase = area;
    radius = Math.min(padX, padY) * 1.5;
  }
  if (b.patch && b.patchBox) {
    // Lettering over artwork: the repaired artwork replaces the flat fill.
    erase = b.patchBox;
    radius = 0;
  }
  // Vertical source text (manga) leaves a tall, narrow box: widen it a bit.
  if (!b.area && b.vertical && area.w < area.h * 0.6) {
    const w = Math.min(area.h * 0.6, page.width);
    area = clampBox({ x: area.x + area.w / 2 - w / 2, y: area.y, w, h: area.h }, page.width, page.height);
  }
  const padding = Math.max(1, Math.min(area.w, area.h) * 0.06);
  const inner = { w: area.w - padding * 2, h: area.h - padding * 2 };

  const c = ctx();
  const measureAt = (size: number): Measure => {
    c.font = `${font.weight} ${size}px ${font.family}`;
    return (s) => c.measureText(s).width;
  };
  const scale = b.fontScale ?? 1;
  // Latin letters look smaller than CJK ones at the same pixel size.
  const maxSize = Math.max(8, original * (capsSource ? SIZE_RATIO_CAPS : SIZE_RATIO) * scale);
  const minSize = Math.max(6, Math.min(original * 0.4, 12));
  let size = minSize;
  let lines = wrapText(display, inner.w, measureAt(minSize), opts.target, Boolean(target.noSpaces));
  let lo = minSize;
  let hi = maxSize;
  // Binary search for the biggest font size that fits the area.
  for (let i = 0; i < 14 && hi - lo > 0.25; i++) {
    const mid = (lo + hi) / 2;
    const m = measureAt(mid);
    // Prefer a smaller font over splitting a word in two.
    const l = wrapText(display, inner.w, m, opts.target, Boolean(target.noSpaces), false);
    if (l && fits(l, mid, inner, m)) {
      lo = mid;
      size = mid;
      lines = l;
    } else hi = mid;
  }
  if (size === minSize) lines = wrapText(display, inner.w, measureAt(minSize), opts.target, Boolean(target.noSpaces));
  lines = balanceLines(display, lines, inner.w, measureAt(size), opts.target, Boolean(target.noSpaces));

  const layout: BubbleLayout = {
    erase,
    radius,
    area,
    padding,
    fill,
    color: b.color ?? contrastColor(fill),
    rotation: b.rotation ?? 0,
    align: b.align ?? 'center',
    patch: b.patch && b.patchBox ? b.patch : undefined,
    outline: Boolean(b.outline),
    fontSize: Math.floor(size * 4) / 4,
    lines,
    family: font.family,
    weight: font.weight,
    rtl: Boolean(target.rtl),
  };
  if (cache.size > 4000) cache.clear();
  cache.set(key, layout);
  return layout;
}

export function clearLayoutCache(): void {
  cache.clear();
}

function roundRect(c: CanvasRenderingContext2D, b: Box, r: number) {
  const radius = Math.max(0, Math.min(r, b.w / 2, b.h / 2));
  c.beginPath();
  c.moveTo(b.x + radius, b.y);
  c.arcTo(b.x + b.w, b.y, b.x + b.w, b.y + b.h, radius);
  c.arcTo(b.x + b.w, b.y + b.h, b.x, b.y + b.h, radius);
  c.arcTo(b.x, b.y + b.h, b.x, b.y, radius);
  c.arcTo(b.x, b.y, b.x + b.w, b.y, radius);
  c.closePath();
}

/** Colour of the stroke drawn around letters set over artwork. */
export function outlineColor(color: string): string {
  return contrastColor(color);
}

/**
 * Paints translated bubbles on a canvas that already holds the original page.
 * `patches` holds the decoded repaired artwork of the layouts that have one.
 */
export function drawLayouts(c: CanvasRenderingContext2D, layouts: BubbleLayout[], patches?: Map<string, CanvasImageSource>): void {
  for (const l of layouts) {
    const patch = l.patch ? patches?.get(l.patch) : undefined;
    if (patch) {
      c.drawImage(patch, l.erase.x, l.erase.y, l.erase.w, l.erase.h);
      continue;
    }
    c.fillStyle = l.fill;
    roundRect(c, l.erase, l.radius);
    c.fill();
  }
  for (const l of layouts) {
    c.save();
    c.font = `${l.weight} ${l.fontSize}px ${l.family}`;
    c.textAlign = l.align;
    c.textBaseline = 'middle';
    c.direction = l.rtl ? 'rtl' : 'ltr';
    const lh = l.fontSize * LINE_HEIGHT;
    const total = l.lines.length * lh;
    const cx = l.area.x + l.area.w / 2;
    const cy = l.area.y + l.area.h / 2;
    c.translate(cx, cy);
    if (l.rotation) c.rotate((l.rotation * Math.PI) / 180);
    const x = l.align === 'left' ? -l.area.w / 2 + l.padding : l.align === 'right' ? l.area.w / 2 - l.padding : 0;
    let y = -total / 2 + lh / 2;
    for (const line of l.lines) {
      if (l.outline) {
        c.lineJoin = 'round';
        c.lineWidth = Math.max(2, l.fontSize * 0.18);
        c.strokeStyle = outlineColor(l.color);
        c.strokeText(line, x, y);
      }
      c.fillStyle = l.color;
      c.fillText(line, x, y);
      y += lh;
    }
    c.restore();
  }
}
