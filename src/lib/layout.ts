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
  /** Lean of italic letters (rightward shift per unit of height). */
  slant: number;
  /** Colour of the stroke around outlined letters. */
  outlineColor: string;
  /** Turn of the plain band hiding tilted lettering on the artwork (degrees), drawn with soft edges. */
  eraseRotation?: number;
  /** Plain band over lettering on the artwork (no repaired artwork): drawn with soft edges. */
  softErase?: boolean;
  /** The bubble drawn again a little bigger (its outline as a polygon, page pixels), to give a long translation room. */
  bubbleOutline?: { points: number[]; rim: string; width: number };
  /** Shift of each line's centre from the centre of `area` (lines fitted to the bubble's shape). */
  lineX?: number[];
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

/**
 * Marks a piece of word that follows the previous unit without a space: a
 * long compound word may go to the next line after its hyphen
 * ("REGARDE-" / "MOI."), as French lettering does, instead of the whole
 * bubble being lettered tiny to hold it on one line.
 */
const GLUE = '\u2060';

/** `line` and `unit` put together on one line (a glued unit takes no space). */
function joinUnit(line: string, unit: string, sep: string): string {
  if (!line) return unit.replace(GLUE, '');
  return unit.startsWith(GLUE) ? line + unit.slice(1) : line + sep + unit;
}

/** A line as drawn: without the glue marks. */
function drawn(line: string): string {
  return line.split(GLUE).join('').trim();
}

function segments(text: string, lang: string, noSpaces: boolean): string[] {
  if (!noSpaces) {
    // Keep French-style detached punctuation (« vas-tu ? ») with its word.
    const out: string[] = [];
    let pendingOpen = '';
    for (const token of text.split(/\s+/).filter(Boolean)) {
      if (CLOSING.test(token) && out.length) out[out.length - 1] += '\u00a0' + token;
      else if (OPENING.test(token)) pendingOpen += token + '\u00a0';
      else {
        // A long compound word may break after its hyphen, between parts
        // of three letters or more ("PEUT-|ÊTRE", not "QU'EST-|CE").
        const parts = token.replace(/[^\p{L}]/gu, '').length >= 9 ? token.split(/(?<=\p{L}{3}-)(?=\p{L}{3})/u) : [token];
        out.push(pendingOpen + parts[0], ...parts.slice(1).map((p) => GLUE + p));
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
    for (const raw of segments(paragraph, lang, noSpaces)) {
      const candidate = joinUnit(line, raw, sep);
      if (measure(drawn(candidate)) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (drawn(line)) lines.push(drawn(line));
      const unit = raw.replace(GLUE, '');
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
    if (drawn(line)) lines.push(drawn(line));
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

/**
 * A bubble that can be drawn again bigger: a smooth, round or oval shape in
 * one piece, holding all of the original lettering. A spiky bubble (a
 * shout), one with gaps (cut by a panel border) or one only partly found
 * was redrawn as a broken polygon, the English left visible beside it.
 */
export function growable(shape: NonNullable<Bubble['shape']>, text: Box): boolean {
  const rows = shape.x.length / 2;
  if (rows < 6) return false;
  const widths: number[] = [];
  for (let i = 0; i < rows; i++) {
    const l = shape.x[i * 2];
    const r = shape.x[i * 2 + 1];
    if (r < l) return false;
    widths.push(r - l);
  }
  const sorted = [...widths].sort((a, b) => a - b);
  const typical = sorted[Math.floor(rows * 0.75)];
  // A box (a narration box, a square bubble): drawn again bigger, its
  // corners came out cut, a polygon over the panel. Its text gets smaller.
  const widest = sorted[rows - 1];
  if (widths.filter((w) => w >= widest * 0.96).length >= rows * 0.7) return false;
  for (let i = 1; i < rows; i++) {
    // The sides of a round bubble move little from one row to the next.
    const jump = Math.max(Math.abs(shape.x[i * 2] - shape.x[i * 2 - 2]), Math.abs(shape.x[i * 2 + 1] - shape.x[i * 2 - 1]));
    if (jump > Math.max(4, typical * 0.12) * Math.max(1, shape.step / 4)) return false;
  }
  for (let i = 1; i < rows - 1; i++) {
    // A spike: a row much wider than both its neighbours.
    if (widths[i] - Math.max(widths[i - 1], widths[i + 1]) > typical * 0.08) return false;
  }
  const top = shape.y;
  const bottom = shape.y + (rows - 1) * shape.step;
  return top <= text.y + text.h * 0.25 && bottom >= text.y + text.h * 0.75;
}

/**
 * A bubble's shape made `k` times bigger around its centre, the margin to
 * its rim kept, within the page; with the polygon of its new rim.
 */
export function grownShape(
  shape: NonNullable<Bubble['shape']>,
  k: number,
  page: { width: number; height: number },
): { shape: NonNullable<Bubble['shape']>; outline: number[] } {
  const inset = shape.inset ?? 0;
  const rows = shape.x.length / 2;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < rows; i++) {
    if (shape.x[i * 2 + 1] < shape.x[i * 2]) continue;
    sum += (shape.x[i * 2] + shape.x[i * 2 + 1]) / 2;
    n++;
  }
  const cx = n ? sum / n : 0;
  const cy = shape.y + ((rows - 1) * shape.step) / 2;
  const x: number[] = [];
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  for (let i = 0; i < rows; i++) {
    const l = shape.x[i * 2];
    const r = shape.x[i * 2 + 1];
    if (r < l) {
      x.push(0, -1);
      continue;
    }
    const rimL = Math.max(0, cx + (l - inset - cx) * k);
    const rimR = Math.min(page.width, cx + (r + inset - cx) * k);
    const y = Math.min(page.height, Math.max(0, cy + (shape.y + i * shape.step - cy) * k));
    x.push(Math.round(rimL + inset), Math.round(rimR - inset));
    left.push([rimL, y]);
    right.push([rimR, y]);
  }
  // The outline: the bubble's own body drawn bigger around the same centre
  // (from the rows kept for text alone, its top and bottom stopped short and
  // bits of the old outline stayed visible), closed by low rounded caps.
  const rimW = Math.max(2, page.width * 0.004);
  let outer: [number, number][][] = [left, right];
  if (shape.body && shape.bodyY !== undefined && shape.body.length >= 6) {
    const bl: [number, number][] = [];
    const br: [number, number][] = [];
    for (let i = 0; i < shape.body.length / 2; i++) {
      const y = Math.min(page.height, Math.max(0, cy + (shape.bodyY + i * shape.step - cy) * k));
      bl.push([Math.max(0, cx + (shape.body[i * 2] - cx) * k - rimW / 2), y]);
      br.push([Math.min(page.width, cx + (shape.body[i * 2 + 1] - cx) * k + rimW / 2), y]);
    }
    outer = [bl, br];
  }
  const [ol, or] = outer;
  const caps: { top: [number, number][]; bottom: [number, number][] } = { top: [], bottom: [] };
  if (ol.length) {
    const l0 = ol[0];
    const r0 = or[0];
    const lb = ol[ol.length - 1];
    const rb = or[or.length - 1];
    const n = 10;
    const riseT = Math.max(inset * k, (r0[0] - l0[0]) * 0.18);
    const riseB = Math.max(inset * k, (rb[0] - lb[0]) * 0.18);
    for (let i = 1; i < n; i++) {
      const t = (Math.PI * i) / n;
      caps.top.push([(l0[0] + r0[0]) / 2 + ((r0[0] - l0[0]) / 2) * Math.cos(t), l0[1] - riseT * Math.sin(t)]);
      caps.bottom.push([(lb[0] + rb[0]) / 2 - ((rb[0] - lb[0]) / 2) * Math.cos(t), lb[1] + riseB * Math.sin(t)]);
    }
  }
  const outline = [...ol, ...caps.bottom, ...[...or].reverse(), ...caps.top].flatMap(([px, py]) => [Math.round(px), Math.round(Math.max(0, Math.min(page.height, py)))]);
  const y0 = cy + (shape.y - cy) * k;
  return { shape: { ...shape, y: Math.round(y0), step: shape.step * k, x }, outline };
}

/**
 * Lines of `text` at `size` fitted to the shape of a bubble: each line as
 * wide as the bubble is at its height, the block centred on `cy` (moved to
 * stay inside). The fewest lines that hold the text; null when it does not fit.
 */
export function fitToShape(
  text: string,
  shape: NonNullable<Bubble['shape']>,
  size: number,
  measure: Measure,
  lang: string,
  noSpaces: boolean,
  cy: number,
): { lines: string[]; left: number[]; right: number[]; top: number; lineH: number } | null {
  const lh = size * LINE_HEIGHT;
  const rows = shape.x.length / 2;
  // Some air between the lines and the rim, as a letterer leaves: the
  // text touched the spikes of shouted bubbles at the top and the bottom.
  const airY = lh * 0.4;
  const airX = size * 0.25;
  const first = shape.y + airY;
  const last = shape.y + (rows - 1) * shape.step - airY;
  const units = text
    .split(/\n+/)
    .flatMap((p, i) => (i > 0 ? ['\n', ...segments(p, lang, noSpaces)] : segments(p, lang, noSpaces)));
  const sep = noSpaces ? '' : ' ';
  const room = (y0: number, y1: number): [number, number] | null => {
    let l = -Infinity;
    let r = Infinity;
    const i0 = Math.max(0, Math.floor((y0 - shape.y) / shape.step));
    const i1 = Math.min(rows - 1, Math.ceil((y1 - shape.y) / shape.step));
    for (let i = i0; i <= i1; i++) {
      l = Math.max(l, shape.x[i * 2] + airX);
      r = Math.min(r, shape.x[i * 2 + 1] - airX);
    }
    return r > l ? [l, r] : null;
  };
  for (let n = 1; n * lh <= last - first + shape.step; n++) {
    const top = Math.min(Math.max(first, cy - (n * lh) / 2), last + shape.step - n * lh);
    const spans: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const s = room(top + i * lh, top + (i + 1) * lh);
      if (!s) break;
      spans.push(s);
    }
    if (spans.length < n) continue;
    // Each line takes the words it has room for, filled from the top, and
    // also from the bottom: the block whose least filled line is the fuller
    // wins (a lone "DIS" on the first line of a round bubble looked dropped).
    const pack = (fromBottom: boolean): string[] | null => {
      const width = (k: number) => {
        const s = spans[fromBottom ? n - 1 - k : k];
        return s[1] - s[0];
      };
      const seq = fromBottom ? [...units].reverse() : units;
      const out: string[] = [];
      let line = '';
      let k = 0;
      // From the bottom a unit goes before the line: glued, the line's
      // first unit takes no space after it.
      const join = (a: string, b: string) => (fromBottom ? (a.startsWith(GLUE) ? b + a.slice(1) : b + sep + a) : joinUnit(a, b, sep));
      for (const u of seq) {
        if (u === '\n') {
          out.push(drawn(line));
          line = '';
          if (++k >= n) return null;
          continue;
        }
        const candidate = line ? join(line, u) : u;
        if (measure(drawn(candidate)) <= width(k)) {
          line = candidate;
          continue;
        }
        if (!line) return null;
        out.push(drawn(line));
        if (++k >= n || measure(drawn(u)) > width(k)) return null;
        line = u;
      }
      if (drawn(line)) out.push(drawn(line));
      if (out.length !== n) return null;
      return fromBottom ? out.reverse() : out;
    };
    const fill = (ls: string[]) => Math.min(...ls.map((l, i) => measure(l) / Math.max(1, spans[i][1] - spans[i][0])));
    const down = pack(false);
    const up = units.includes('\n') ? null : pack(true);
    const lines = down && up ? (fill(up) > fill(down) ? up : down) : (down ?? up);
    if (!lines) {
      // Not even one try fits this many lines: more lines, or nothing fits.
      continue;
    }
    return { lines, left: spans.map((s) => s[0]), right: spans.map((s) => s[1]), top, lineH: lh };
  }
  return null;
}

const cache = new Map<string, BubbleLayout | null>();

/** Computes where and how big the translation of a bubble is drawn. */
export function layoutBubble(b: Bubble, page: { width: number; height: number }, opts: LayoutOptions): BubbleLayout | null {
  const text = b.translation.trim();
  if (!text || b.hidden) return null;
  // Only OCR measures the line box itself; AI boxes include the line spacing.
  const capsSource = b.confidence !== undefined && isAllCaps(b.original);
  const key = JSON.stringify([b.x, b.y, b.w, b.h, b.area, text, b.fill, b.color, b.fontScale, b.fontSize, b.outline, b.outlineColor, b.slant, opts, page.width, capsSource, b.rotation, b.align, b.patchBox, b.patch?.length, b.shape?.y, b.shape?.x.length, b.roomy, b.caps]);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const target = targetLanguage(opts.target);
  const font = FONTS[opts.font] ?? FONTS.comic;
  // Same case as the source: scanlations lettered in capitals stay in capitals.
  // A short cry ("I…", "UM…") on a page lettered in capitals is in capitals
  // too (it came out "Je…", "Euh…" beside the capitals of the page).
  const upper = opts.letterCase === 'upper' || (opts.letterCase === 'original' && (b.caps || isAllCaps(b.original)));
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
    // A text cut between two pages is laid out whole on each of them (each
    // shows its part): cut to the page, the two halves were laid out
    // differently, one of them in tiny letters.
    const box = { x: b.x - padX, y: b.y - padY, w: b.w + padX * 2, h: b.h + padY * 2 };
    area = b.seam ? { ...clampBox({ ...box, y: 0 }, page.width, Infinity), y: box.y, h: box.h } : clampBox(box, page.width, page.height);
    erase = area;
    radius = Math.min(padX, padY) * 1.5;
  }
  if (b.patch && b.patchBox) {
    // Lettering over artwork: the repaired artwork replaces the flat fill.
    erase = b.patchBox;
    radius = 0;
  }
  // Tilted lettering on the artwork: the box holds the tilted lines; the
  // translation is set in the lines' own frame, as long and as tall as they
  // are, then turned like them.
  if (!b.area && b.rotation && Math.abs(b.rotation) <= 35) {
    const t = (Math.abs(b.rotation) * Math.PI) / 180;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    const d = cos * cos - sin * sin;
    const w = Math.max(area.w * 0.5, (area.w * cos - area.h * sin) / d);
    const h = Math.max(original * 1.6, (area.h * cos - area.w * sin) / d);
    area = { x: area.x + area.w / 2 - w / 2, y: area.y + area.h / 2 - h / 2, w, h };
    // Without repaired artwork, the plain band follows the lines instead of
    // covering the whole upright box (and the drawing around it).
    if (!b.patch) {
      const pad = original * 0.35;
      erase = { x: area.x - pad, y: area.y - pad, w: area.w + pad * 2, h: area.h + pad * 2 };
      radius = original * 0.6;
    }
  }
  // Vertical source text (manga) leaves a tall, narrow box: widen it a bit.
  if (!b.area && b.vertical && area.w < area.h * 0.6) {
    const w = Math.min(area.h * 0.6, page.width);
    area = clampBox({ x: area.x + area.w / 2 - w / 2, y: area.y, w, h: area.h }, page.width, page.height);
  }
  let padding = Math.max(1, Math.min(area.w, area.h) * 0.06);
  const inner = { w: area.w - padding * 2, h: area.h - padding * 2 };

  const c = ctx();
  const measureAt = (size: number): Measure => {
    c.font = `${font.weight} ${size}px ${font.family}`;
    return (s) => c.measureText(s).width;
  };
  const scale = b.fontScale ?? 1;
  // Latin letters look smaller than CJK ones at the same pixel size.
  // Lettering on the artwork keeps its size: a short translation of a
  // small handwritten line grew to fill its box and looked shouted.
  // A bubble known by its shape only (no inner box found) is a bubble too:
  // held to the size of the original, its French came out a quarter smaller
  // than the English, in a bubble with room to spare.
  const ratio = b.area || b.shape ? (capsSource ? SIZE_RATIO_CAPS : SIZE_RATIO) : 1.05;
  const maxSize = Math.max(8, original * ratio * scale);
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

  // Lettering on the artwork, with a translation much longer than the
  // original: the room for it grows over the drawing around (the original
  // letters stay erased as before), up to half again, instead of the
  // French being written tiny in the place of a short English line.
  if (!b.area && !b.shape && b.roomy && b.seam === undefined && size < maxSize * 0.8) {
    for (const k of [1.15, 1.3, 1.5]) {
      const grown = clampBox(
        { x: area.x + (area.w * (1 - k)) / 2, y: area.y + (area.h * (1 - k)) / 2, w: area.w * k, h: area.h * k },
        page.width,
        page.height,
      );
      const pad2 = Math.max(1, Math.min(grown.w, grown.h) * 0.06);
      const in2 = { w: grown.w - pad2 * 2, h: grown.h - pad2 * 2 };
      let s2 = 0;
      let l2: string[] | null = null;
      let lo2 = size;
      let hi2 = maxSize;
      for (let i = 0; i < 12 && hi2 - lo2 > 0.25; i++) {
        const mid = (lo2 + hi2) / 2;
        const m = measureAt(mid);
        const l = wrapText(display, in2.w, m, opts.target, Boolean(target.noSpaces), false);
        if (l && fits(l, mid, in2, m)) {
          lo2 = mid;
          s2 = mid;
          l2 = l;
        } else hi2 = mid;
      }
      if (l2 && s2 > size * 1.08) {
        area = grown;
        padding = pad2;
        size = s2;
        lines = balanceLines(display, l2, in2.w, measureAt(s2), opts.target, Boolean(target.noSpaces));
        if (s2 >= maxSize * 0.8) break;
      }
    }
  }

  // In a bubble whose shape is known: the lines follow its rim, each as wide
  // as the bubble is at its height (narrower at the top and the bottom of a
  // round or spiky bubble), and never run over it.
  let lineX: number[] | undefined;
  let bubbleOutline: BubbleLayout['bubbleOutline'];
  // A bubble read whole across two pages has its shape too (in each page's
  // coordinates): laid out the same on both, each drawing its part.
  if (b.shape && !b.rotation && !b.vertical) {
    const cy = b.y + b.h / 2;
    let best: ReturnType<typeof fitToShape> = null;
    let bestSize = 0;
    let lo2 = minSize;
    let hi2 = maxSize;
    for (let i = 0; i < 14 && hi2 - lo2 > 0.25; i++) {
      const mid = (lo2 + hi2) / 2;
      const fit = fitToShape(display, b.shape, mid, measureAt(mid), opts.target, Boolean(target.noSpaces), cy);
      if (fit) {
        best = fit;
        bestSize = mid;
        lo2 = mid;
      } else hi2 = mid;
    }
    if (!best) {
      best = fitToShape(display, b.shape, minSize, measureAt(minSize), opts.target, Boolean(target.noSpaces), cy);
      bestSize = minSize;
    }
    // The translation much smaller than the original lettering (French runs
    // longer than English): the bubble is drawn again a little bigger, up to
    // a quarter, with its outline, and the text takes the room gained.
    let outline: number[] | undefined;
    // Only when the French would be clearly smaller than the original
    // letters (a bubble drawn again for a few per cent hid its tail and
    // looked redrawn for nothing).
    const wanted = Math.min(maxSize * 0.8, original * scale * 0.85);
    if (best && bestSize < wanted && b.seam === undefined && b.shape.whole && b.shape.inset !== undefined && growable(b.shape, b)) {
      for (const k of [1.08, 1.16, 1.25]) {
        const g = grownShape(b.shape, k, page);
        let fit: ReturnType<typeof fitToShape> = null;
        let fitSize = 0;
        let lo3 = bestSize;
        let hi3 = maxSize;
        for (let i = 0; i < 12 && hi3 - lo3 > 0.25; i++) {
          const mid = (lo3 + hi3) / 2;
          const f = fitToShape(display, g.shape, mid, measureAt(mid), opts.target, Boolean(target.noSpaces), cy);
          if (f) {
            fit = f;
            fitSize = mid;
            lo3 = mid;
          } else hi3 = mid;
        }
        if (fit && fitSize > bestSize * 1.08) {
          best = fit;
          bestSize = fitSize;
          outline = g.outline;
          if (fitSize >= wanted) break;
        }
      }
    }
    if (outline) bubbleOutline = { points: outline, rim: b.shape.rim ?? '#1a1a1a', width: Math.max(1.5, page.width * 0.003) };
    if (best) {
      const left = Math.min(...best.left);
      const right = Math.max(...best.right);
      area = { x: left, y: best.top, w: right - left, h: best.lines.length * best.lineH };
      const mid = area.x + area.w / 2;
      lineX = best.left.map((l, i) => (l + best!.right[i]) / 2 - mid);
      lines = best.lines;
      size = bestSize;
    }
  }
  const pad0 = lineX ? 0 : padding;

  const layout: BubbleLayout = {
    erase,
    radius,
    area,
    padding: pad0,
    fill,
    color: b.color ?? contrastColor(fill),
    rotation: b.rotation ?? 0,
    slant: b.slant ?? 0,
    outlineColor: b.outlineColor ?? outlineColor(b.color ?? contrastColor(fill)),
    lineX,
    bubbleOutline,
    softErase: !b.area && !b.patch && !b.shape ? true : undefined,
    eraseRotation: !b.area && !b.patch && b.rotation && Math.abs(b.rotation) <= 35 ? b.rotation : undefined,
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
function drawOutline(c: CanvasRenderingContext2D, fill: string, outline: NonNullable<BubbleLayout['bubbleOutline']>): void {
  const p = outline.points;
  c.save();
  c.beginPath();
  c.moveTo(p[0], p[1]);
  for (let i = 2; i < p.length; i += 2) c.lineTo(p[i], p[i + 1]);
  c.closePath();
  c.fillStyle = fill;
  c.fill();
  c.lineJoin = 'round';
  c.lineWidth = outline.width;
  c.strokeStyle = outline.rim;
  c.stroke();
  c.restore();
}

export function drawLayouts(c: CanvasRenderingContext2D, layouts: BubbleLayout[], patches?: Map<string, CanvasImageSource>): void {
  for (const l of layouts) {
    const patch = l.patch ? patches?.get(l.patch) : undefined;
    if (patch) c.drawImage(patch, l.erase.x, l.erase.y, l.erase.w, l.erase.h);
    // The bubble drawn bigger for a long translation, over the repaired
    // lettering too: left out of exported pages, their text ran out of the
    // bubble (the reader drew it).
    if (patch && l.bubbleOutline) drawOutline(c, l.fill, l.bubbleOutline);
    if (patch) continue;
    c.save();
    c.fillStyle = l.fill;
    if (l.eraseRotation) {
      const cx = l.erase.x + l.erase.w / 2;
      const cy = l.erase.y + l.erase.h / 2;
      c.translate(cx, cy);
      c.rotate((l.eraseRotation * Math.PI) / 180);
      c.translate(-cx, -cy);
    }
    if (l.eraseRotation || l.softErase) {
      c.shadowColor = l.fill;
      c.shadowBlur = l.fontSize * 0.6;
    }
    roundRect(c, l.erase, l.radius);
    c.fill();
    c.restore();
    if (l.bubbleOutline) drawOutline(c, l.fill, l.bubbleOutline);
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
    // Italic lean: the top of the letters goes right.
    if (l.slant) c.transform(1, 0, -l.slant, 1, 0, 0);
    const x0 = l.align === 'left' ? -l.area.w / 2 + l.padding : l.align === 'right' ? l.area.w / 2 - l.padding : 0;
    let y = -total / 2 + lh / 2;
    for (const [i, line] of l.lines.entries()) {
      const x = x0 + (l.lineX?.[i] ?? 0);
      if (l.outline) {
        c.lineJoin = 'round';
        c.lineWidth = Math.max(2, l.fontSize * 0.18);
        c.strokeStyle = l.outlineColor;
        c.strokeText(line, x, y);
      }
      c.fillStyle = l.color;
      c.fillText(line, x, y);
      y += lh;
    }
    c.restore();
  }
}
