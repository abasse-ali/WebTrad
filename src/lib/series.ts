/**
 * Works out which chapters follow each other from their titles
 * ("Solo Leveling - Chapter 12" → series "solo leveling", number 12) and
 * guesses the address of the next chapter of a link import.
 * Pure helpers: no DOM, no storage.
 */

export interface ChapterRef {
  /** Normalised series name ('' when the title is only "Chapter 12"). */
  series: string;
  /** Chapter number, null when the title has none. */
  number: number | null;
}

const NUMBER = String.raw`(\d+(?:[.,]\d+)?)`;
const KEYWORD = new RegExp(
  String.raw`(?:(?<!\p{L})(?:chapitre|chapter|chap|ch|cap[ií]tulo|cap|[eé]pisode|episodio|[eé]p)(?!\p{L})|#|第)[\s.\-:]*(?:n°\s*)?` + NUMBER,
  'giu',
);
const LAST_NUMBER = new RegExp(NUMBER + String.raw`(?!.*\d)`, 'su');
const EDGE_JUNK = /^[\s\-–—:|·,.#()[\]]+|[\s\-–—:|·,.#()[\]]+$/gu;

export function parseChapterTitle(title: string): ChapterRef {
  const text = title.normalize('NFKC').toLowerCase().replace(/[_\s]+/g, ' ').trim();
  let match: RegExpExecArray | null = null;
  // A number announced by "chapter", "ep."… wins over any other number of the
  // title ("86 - Chapter 5", "Chapter 12 - Level 99"); the last one is kept.
  for (const m of text.matchAll(KEYWORD)) match = m;
  match ??= LAST_NUMBER.exec(text);
  if (!match) return { series: text.replace(EDGE_JUNK, ''), number: null };
  const number = Number(match[1].replace(',', '.'));
  return { series: text.slice(0, match.index).replace(EDGE_JUNK, ''), number: Number.isFinite(number) ? number : null };
}

/** Chapters of the same series right before and after `current`, by chapter number. */
export function neighbours<T extends { id: string; title: string }>(
  all: T[],
  current: { id: string; title: string },
): { previous?: T; next?: T } {
  const ref = parseChapterTitle(current.title);
  if (ref.number === null) return {};
  let previous: { item: T; n: number } | undefined;
  let next: { item: T; n: number } | undefined;
  for (const item of all) {
    if (item.id === current.id) continue;
    const other = parseChapterTitle(item.title);
    if (other.number === null || other.series !== ref.series) continue;
    if (other.number < ref.number && (!previous || other.number > previous.n)) previous = { item, n: other.number };
    if (other.number > ref.number && (!next || other.number < next.n)) next = { item, n: other.number };
  }
  return { previous: previous?.item, next: next?.item };
}

function increment(digits: string): string {
  return String(Number(digits) + 1).padStart(digits.length, '0');
}

/**
 * Next chapter by counting: ".../chapter-12/" → ".../chapter-13/",
 * "?episode_no=7" → "?episode_no=8". A guess: the page may not exist.
 */
export function guessNextUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const segments = u.pathname.split('/');
  for (let i = segments.length - 1; i >= 0; i--) {
    // Last number of the last path segment that has one ("chapter-12.html").
    const m = segments[i].match(/^(.*?)(\d{1,5})(\D*)$/);
    if (!m) continue;
    const [, before, digits, after] = m;
    // "chapter-12", "ep12", "12": a counter. "5f3a9c12", "1234567": an id.
    if (before === '' || /[-_.~+]$/.test(before) || /^\p{L}+$/u.test(before)) {
      segments[i] = before + increment(digits) + after;
      u.pathname = segments.join('/');
      return u.href;
    }
    break;
  }
  const numeric = [...u.searchParams.entries()].filter(([, v]) => /^\d{1,5}$/.test(v));
  const param = numeric.find(([k]) => /ep|chap/i.test(k)) ?? numeric.find(([k]) => /^(no|num)$/i.test(k));
  if (!param) return null;
  u.searchParams.set(param[0], increment(param[1]));
  return u.href;
}

/** Words sites wrap chapter titles in ("Read … Online"): not part of the series name. */
const SITE_WORDS = /^(?:read|lire|leer)\s+|\s+(?:online|en ligne|vf|vostfr|raw|scan|manga|manhwa|webtoon)$/giu;

function stripSiteWords(name: string): string {
  let out = name;
  for (let i = 0; i < 3; i++) out = out.replace(SITE_WORDS, '').replace(EDGE_JUNK, '');
  return out;
}

/** The series of a chapter title: a key to group by and a name to show. */
export function seriesOf(title: string): { key: string; name: string; number: number | null } {
  const ref = parseChapterTitle(title);
  const key = stripSiteWords(ref.series);
  const text = title.normalize('NFKC').replace(/[_\s]+/g, ' ').trim();
  let cut = -1;
  for (const m of text.matchAll(KEYWORD)) cut = m.index ?? cut;
  if (cut < 0 && ref.number !== null) cut = LAST_NUMBER.exec(text)?.index ?? -1;
  const name = stripSiteWords(cut >= 0 ? text.slice(0, cut) : text) || title;
  return { key, name, number: ref.number };
}

export interface SeriesGroup<T> {
  key: string;
  name: string;
  /** Chapters in reading order (by chapter number). */
  items: T[];
}

/**
 * Chapters of the same manga, grouped. Groups keep the order of their first
 * chapter in `items` (most recent first, or by title); titles without a
 * series name ("Chapter 3") stay on their own.
 */
export function groupBySeries<T extends { id: string; title: string }>(items: T[]): SeriesGroup<T>[] {
  const groups = new Map<string, SeriesGroup<T> & { numbers: Map<string, number> }>();
  for (const item of items) {
    const s = seriesOf(item.title);
    const key = s.key ? `s:${s.key}` : `c:${item.id}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, name: s.key ? s.name : item.title, items: [], numbers: new Map() };
      groups.set(key, group);
    }
    group.items.push(item);
    group.numbers.set(item.id, s.number ?? Number.POSITIVE_INFINITY);
  }
  return [...groups.values()].map(({ numbers, ...g }) => ({
    ...g,
    items: g.items.slice().sort((a, b) => (numbers.get(a.id) ?? 0) - (numbers.get(b.id) ?? 0)),
  }));
}
