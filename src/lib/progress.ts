/**
 * Reading position of each chapter, kept in localStorage: it is written while
 * scrolling, far too often for IndexedDB (every write there reloads the views).
 */

export interface ReadingPosition {
  /** Index of the page at the top of the screen. */
  page: number;
  /** How far into that page the reader is, 0–1 of its height. */
  offset: number;
  /** Share of the chapter already scrolled through, 0–1. */
  ratio: number;
  /** The end of the chapter was reached at least once. */
  finished: boolean;
}

const KEY = (chapterId: string) => `webtrad.pos.${chapterId}`;
const LAST_KEY = 'webtrad.last';

const clamp01 = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** Reads a stored position; older versions stored the bare page index. */
export function parsePosition(raw: string | null | undefined): ReadingPosition | null {
  if (!raw) return null;
  const legacy = Number(raw);
  if (Number.isInteger(legacy) && legacy >= 0) return { page: legacy, offset: 0, ratio: 0, finished: false };
  try {
    const v = JSON.parse(raw) as { p?: unknown; o?: unknown; r?: unknown; f?: unknown };
    if (typeof v !== 'object' || v === null || typeof v.p !== 'number' || !Number.isInteger(v.p) || v.p < 0) return null;
    return { page: v.p, offset: clamp01(v.o), ratio: clamp01(v.r), finished: Boolean(v.f) };
  } catch {
    return null;
  }
}

export function serialisePosition(pos: ReadingPosition): string {
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return JSON.stringify({ p: pos.page, o: round(pos.offset), r: round(pos.ratio), f: pos.finished ? 1 : 0 });
}

export function loadPosition(chapterId: string): ReadingPosition | null {
  try {
    return parsePosition(localStorage.getItem(KEY(chapterId)));
  } catch {
    return null;
  }
}

export function savePosition(chapterId: string, pos: ReadingPosition): void {
  try {
    localStorage.setItem(KEY(chapterId), serialisePosition(pos));
  } catch {
    /* private mode / quota: the position is simply not remembered */
  }
}

export function clearPosition(chapterId: string): void {
  try {
    localStorage.removeItem(KEY(chapterId));
    if (localStorage.getItem(LAST_KEY) === chapterId) localStorage.removeItem(LAST_KEY);
  } catch {
    /* ignore */
  }
}

export function clearAllPositions(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && (key.startsWith('webtrad.pos.') || key === LAST_KEY)) localStorage.removeItem(key);
    }
  } catch {
    /* ignore */
  }
}

/** Remembers the chapter being read so the library can offer to resume it. */
export function setLastRead(chapterId: string): void {
  try {
    localStorage.setItem(LAST_KEY, chapterId);
  } catch {
    /* ignore */
  }
}

export function getLastRead(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}
