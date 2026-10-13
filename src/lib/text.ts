/**
 * Pure helpers that turn raw OCR lines into speech-bubble sized text blocks.
 * No DOM access here so the logic can be unit tested.
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OcrLine extends Box {
  text: string;
  confidence: number;
}

export interface TextBlock extends Box {
  text: string;
  confidence: number;
  vertical: boolean;
  lines: OcrLine[];
}

export interface LangRules {
  script: RegExp;
  noSpaces?: boolean;
}

const CJK = '\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef\\u3000-\\u303f';
const CJK_GAP = new RegExp(`([${CJK}])\\s+(?=[${CJK}])`, 'gu');
const LETTER = /\p{L}/u;

export function isVerticalBox(b: Box): boolean {
  return b.h > b.w * 1.6;
}

/** Normalises whitespace and OCR quirks of a single line. */
export function cleanLine(text: string, rules: LangRules): string {
  let t = text.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (rules.noSpaces) t = t.replace(CJK_GAP, '$1');
  // Stray symbols Tesseract likes to add around bubble borders.
  t = t.replace(/^[|\\/_\-=~`'"“”‘’,.:;]+(?=\p{L})/u, '').replace(/(?<=[\p{L}!?.…])[|\\/_=~`]+$/u, '');
  return t.trim();
}

/** Share of letters in `text` that belong to the expected source script. */
export function scriptRatio(text: string, script: RegExp): number {
  let letters = 0;
  let matching = 0;
  for (const ch of text) {
    if (!LETTER.test(ch)) continue;
    letters++;
    if (script.test(ch)) matching++;
  }
  return letters === 0 ? 0 : matching / letters;
}

/** True when a line or block looks like real text in the source language. */
export function isMeaningful(text: string, rules: LangRules): boolean {
  let matching = 0;
  for (const ch of text) if (rules.script.test(ch)) matching++;
  const minChars = rules.noSpaces || !/[A-Za-z]/.test(rules.script.source) ? 1 : 2;
  return matching >= minChars && scriptRatio(text, rules.script) >= 0.6;
}

function overlap1d(a0: number, a1: number, b0: number, b1: number): number {
  return Math.min(a1, b1) - Math.max(a0, b0);
}

/** Decides whether two lines belong to the same text block. */
function sameBlock(a: OcrLine, b: OcrLine): boolean {
  const aVert = isVerticalBox(a) && a.text.length > 1;
  const bVert = isVerticalBox(b) && b.text.length > 1;
  if (aVert && bVert) {
    // Vertical columns: side by side, overlapping vertically.
    const size = Math.min(a.w, b.w);
    const gap = -overlap1d(a.x, a.x + a.w, b.x, b.x + b.w);
    const vOverlap = overlap1d(a.y, a.y + a.h, b.y, b.y + b.h);
    return gap <= size * 1.0 && vOverlap > Math.min(a.h, b.h) * 0.2;
  }
  const size = Math.min(a.h, b.h);
  const big = Math.max(a.h, b.h);
  if (big > size * 2.2) return false; // very different font sizes
  const vGap = -overlap1d(a.y, a.y + a.h, b.y, b.y + b.h);
  const hOverlap = overlap1d(a.x, a.x + a.w, b.x, b.x + b.w);
  // Stacked lines of the same bubble.
  if (vGap <= size * 0.9 && hOverlap > Math.min(size, Math.min(a.w, b.w) * 0.3)) return true;
  // Fragments of the same row that Tesseract split in two.
  if (vGap < -size * 0.5 && -hOverlap <= size * 1.2) return true;
  return false;
}

/**
 * Groups OCR lines into blocks (≈ speech bubbles) with a union–find over
 * pairs of lines that are close enough to be part of the same paragraph.
 */
export function groupLines(lines: OcrLine[], rules: LangRules): TextBlock[] {
  const n = lines.length;
  const parent = lines.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (sameBlock(lines[i], lines[j])) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, OcrLine[]>();
  lines.forEach((line, i) => {
    const root = find(i);
    const list = groups.get(root) ?? [];
    list.push(line);
    groups.set(root, list);
  });

  const blocks: TextBlock[] = [];
  for (const members of groups.values()) {
    const x0 = Math.min(...members.map((l) => l.x));
    const y0 = Math.min(...members.map((l) => l.y));
    const x1 = Math.max(...members.map((l) => l.x + l.w));
    const y1 = Math.max(...members.map((l) => l.y + l.h));
    const vertical = members.length > 0 && members.every((l) => isVerticalBox(l) && l.text.length > 1);
    const ordered = [...members].sort((a, b) =>
      vertical ? b.x + b.w / 2 - (a.x + a.w / 2) : a.y + a.h / 2 - (b.y + b.h / 2) || a.x - b.x,
    );
    // Same-row fragments need left-to-right order.
    const rows: OcrLine[][] = [];
    for (const line of ordered) {
      const row = rows.at(-1);
      if (!vertical && row && overlap1d(row[0].y, row[0].y + row[0].h, line.y, line.y + line.h) > line.h * 0.5) {
        row.push(line);
        row.sort((a, b) => a.x - b.x);
      } else rows.push([line]);
    }
    const text = joinLines(
      rows.map((r) => r.map((l) => l.text).join(rules.noSpaces ? '' : ' ')),
      rules,
    );
    const weight = members.reduce((s, l) => s + l.text.length, 0) || 1;
    const confidence = members.reduce((s, l) => s + l.confidence * l.text.length, 0) / weight;
    blocks.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, text, confidence, vertical, lines: ordered });
  }
  // Reading order: top to bottom, then left to right (webtoon / comics).
  return blocks.sort((a, b) => a.y - b.y || a.x - b.x);
}

export function joinLines(lines: string[], rules: LangRules): string {
  let out = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (!out) out = line;
    else if (rules.noSpaces) out += line;
    else if (/[A-Za-z]-$/.test(out)) out = out.slice(0, -1) + line;
    else out += ' ' + line;
  }
  return rules.noSpaces ? out.replace(CJK_GAP, '$1') : out;
}

/**
 * Comics lettering is often ALL CAPS, which machine translation handles
 * poorly. Turn it into sentence case before translating.
 */
export function normaliseCase(text: string): string {
  const letters = text.match(/[A-Za-zÀ-ÖØ-öø-ÿ]/g);
  if (!letters || letters.length < 3) return text;
  const upper = letters.filter((c) => c === c.toUpperCase() && c !== c.toLowerCase()).length;
  if (upper / letters.length < 0.8) return text;
  const lower = text.toLowerCase();
  return lower
    .replace(/(^\s*|[.!?…]\s+)(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase())
    .replace(/\bi\b/g, 'I');
}

/** Removes blocks fully contained in a bigger one (duplicates from tile overlaps). */
export function dedupeBlocks<T extends Box>(blocks: T[]): T[] {
  const sorted = [...blocks].sort((a, b) => b.w * b.h - a.w * a.h);
  const kept: T[] = [];
  for (const b of sorted) {
    const area = b.w * b.h;
    const dup = kept.some((k) => {
      const ix = overlap1d(k.x, k.x + k.w, b.x, b.x + b.w);
      const iy = overlap1d(k.y, k.y + k.h, b.y, b.y + b.h);
      return ix > 0 && iy > 0 && (ix * iy) / area > 0.6;
    });
    if (!dup) kept.push(b);
  }
  return kept.sort((a, b) => a.y - b.y || a.x - b.x);
}
