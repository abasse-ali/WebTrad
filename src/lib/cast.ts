/**
 * The characters of each series, as the AI named them ("Mina", "masked man"),
 * with their gender and the voice given to them for reading aloud. Kept per
 * series, so that a character speaks with the same voice from one chapter to
 * the next, and so that the AI is told the labels it used before.
 */
import { seriesOf } from './series';
import type { Bubble } from './types';

const KEY = 'webtrad.cast.v1';

export interface CastMember {
  /** The label as the AI wrote it the first time. */
  label: string;
  gender?: 'male' | 'female';
  /** Texts seen for this character (the most seen are listed first to the AI). */
  seen: number;
  /** Voice given for reading aloud (its name), with its pitch. */
  voice?: string;
  pitch?: number;
}

type Store = Record<string, Record<string, CastMember>>;

function load(): Store {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Store;
  } catch {
    return {};
  }
}

function save(store: Store): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // Storage full or blocked: voices are given again next time.
  }
}

/** The key of a chapter's series (its title when it has no series). */
export function seriesKeyOf(title: string): string {
  return seriesOf(title).key || title.trim().toLowerCase();
}

/** "The masked man" and "masked man" are the same character. */
export function speakerKey(label: string): string {
  return label
    .normalize('NFKC')
    .toLowerCase()
    .replace(/^(the|a|an|le|la|les|l'|un|une)\s+/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Labels that are not characters. */
export function isNarrator(label: string | undefined): boolean {
  return !label || /^(narrator|narration|narrateur|sign|text|caption|unknown|none)$/i.test(label.trim());
}

/** Counts the speakers of new bubbles in the series' cast. */
export function rememberSpeakers(title: string, bubbles: Bubble[]): void {
  const said = bubbles.filter((b) => b.speaker && !isNarrator(b.speaker));
  if (said.length === 0) return;
  const store = load();
  const cast = (store[seriesKeyOf(title)] ??= {});
  for (const b of said) {
    const key = speakerKey(b.speaker!);
    if (!key) continue;
    const m = (cast[key] ??= { label: b.speaker!, seen: 0 });
    m.seen++;
    if (!m.gender && b.gender) m.gender = b.gender;
  }
  save(store);
}

/** The cast of a series, the most seen characters first. */
export function castOf(title: string): (CastMember & { key: string })[] {
  const cast = load()[seriesKeyOf(title)] ?? {};
  return Object.entries(cast)
    .map(([key, m]) => ({ key, ...m }))
    .sort((a, b) => b.seen - a.seen);
}

/** The characters as told to the AI: "- Mina (female)", at most 24. */
export function charactersFor(title: string): string | undefined {
  const list = castOf(title).slice(0, 24);
  if (list.length === 0) return undefined;
  return list.map((m) => `- ${m.label}${m.gender ? ` (${m.gender})` : ''}`).join('\n');
}

/** Changes a character's entry (voice given, gender corrected). */
export function updateMember(title: string, key: string, patch: Partial<CastMember>, label = key): void {
  const store = load();
  const cast = (store[seriesKeyOf(title)] ??= {});
  const m = cast[key] ?? { label, seen: 0 };
  cast[key] = { ...m, ...patch };
  save(store);
}

/** Forgets the voices given in a series (they are given again when next read). */
export function resetVoices(title: string): void {
  const store = load();
  const cast = store[seriesKeyOf(title)];
  if (!cast) return;
  for (const m of Object.values(cast)) {
    delete m.voice;
    delete m.pitch;
  }
  save(store);
}
