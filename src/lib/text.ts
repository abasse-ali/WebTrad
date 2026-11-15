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
  /** Read with high confidence: may start a text block on its own. */
  strong?: boolean;
  /** Slope of the baseline in degrees, clockwise (0 when unknown). */
  angle?: number;
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
  // A lone capital I is often read as a bar: "| am waiting".
  if (isLatin(rules)) t = t.replace(/(^|\s)\|(?=\s+[\p{Ll}'’])/gu, '$1I');
  // A lone "I…" is read as a bar or a lowercase L, then dropped as debris.
  if (isLatin(rules)) t = t.replace(/^[|l1](?=\s*(?:\.{2,}|…|[!?]+)\s*$)/u, 'I');
  if (isLatin(rules)) t = fixCapsConfusions(t);
  if (isLatin(rules)) t = stripJunkTokens(t);
  // Stray symbols Tesseract likes to add around bubble borders.
  t = t.replace(/^[|\\/_\-=~`'"“”‘’,.:;]+(?=\p{L})/u, '').replace(/(?<=[\p{L}!?.…])[|\\/_=~`]+$/u, '');
  return t.trim();
}

/**
 * In text lettered in capitals, OCR reads the pronoun I as "|" or "1" and
 * mixes up letters and digits inside words ("1S", "Y0U").
 */
export function fixCapsConfusions(text: string): string {
  const letters = text.replace(/[^A-Za-z]/g, '');
  if (letters.length < 3 || letters !== letters.toUpperCase()) return text;
  const tokens = text.split(' ');
  return tokens
    .map((tok, i) => {
      const next = tokens[i + 1] ?? '';
      if ((tok === '|' || tok === '1' || tok === 'l') && /^[A-Z]/.test(next)) return 'I';
      if (/^[|1]['’][A-Z]/.test(tok)) return 'I' + tok.slice(1); // "1'M" → "I'M"
      if (/[A-Z]/.test(tok) && /[01]/.test(tok) && !/[2-9]/.test(tok) && /^[A-Z01'’-]+[!?.,…]*$/.test(tok)) {
        return tok.replace(/1/g, 'I').replace(/0/g, 'O');
      }
      return tok;
    })
    .join(' ');
}

const STRAY_SYMBOL = /^[%&$§#*@+=~^|<>«»"“”'’`°_\\/[\](){}]+$/u;

/**
 * Removes what OCR makes of the specks of grainy or spiky bubble rims from
 * text lettered in capitals: lone digits ("3 AND I…"), symbols ("% TISSUES"),
 * a lone consonant, and lowercase debris before or after the text
 * ("…THE EVENT. ki", "…OFF ME... fo Bene som").
 */
export function trimStrayTokens(text: string): string {
  const letters = text.replace(/[^A-Za-z]/g, '');
  const upper = letters.replace(/[^A-Z]/g, '').length;
  const caps = letters.length >= 3 && upper / letters.length >= 0.8;
  if (!caps) return text;
  // Lone digits are debris, unless the text holds real numbers.
  const numbers = (text.match(/\d{2,}/g) ?? []).length > 0;
  let tokens = text.split(/\s+/).filter(Boolean);
  tokens = tokens.filter((t) => {
    if (STRAY_SYMBOL.test(t)) return false;
    if (!numbers && /^\d[.,:;!?…]*$/.test(t)) return false;
    if (/^[B-HJ-NP-Z]$/.test(t)) return false;
    return true;
  });
  while (tokens.length && /[a-z]/.test(tokens[tokens.length - 1])) tokens.pop();
  // A lone letter after the end of the sentence ("…AGAIN...? A") is a speck too.
  if (tokens.length >= 2 && /^[A-Z]$/.test(tokens[tokens.length - 1]) && /[.!?…]$/.test(tokens[tokens.length - 2])) tokens.pop();
  while (tokens.length && /[a-z]/.test(tokens[0])) tokens.shift();
  return tokens.join(' ');
}

const INTERJECTION =
  /^(?:[A-Z]{1,2}-)*(?:H+M+|H+N+G*H*|M+|S+H+|P+S+T+|T+S+K+|B+R+|G+R+|Z+|A+R*G+H+|U+G+H+|N+G+H*|E+H+|A+H+|O+H+|U+H+|H+U+H+|H+A+H+|H+E+H+|O+W+|W+O+W+|O+U+C+H+|H+E+Y+|N+O+|I|A|O)$/;

/**
 * Text that reads like comic lettering: capitals only, every word either a
 * real-looking word or a known interjection ("HNGH", "UGH", "I"). Inside a
 * speech bubble such short texts are real and must be kept.
 */
export function isLikelyLettering(text: string): boolean {
  const words = text.match(/[\p{L}'’-]+/gu) ?? [];
  if (words.length === 0 || words.length > 40) return false;
  const letters = text.replace(/[^\p{L}]/gu, '');
  if (letters !== letters.toUpperCase()) return false;
  return words.every((w) => {
    const bare = w.replace(/['’]/g, '').replace(/^-+|-+$/g, '');
    return INTERJECTION.test(bare) || (bare.length >= 2 && VOWEL.test(bare));
  });
}

export function isLatin(rules: LangRules): boolean {
  return /[A-Za-z]/.test(rules.script.source);
}

/** Letters of the source script in a text. */
export function scriptLetters(text: string, rules: LangRules): number {
  let n = 0;
  for (const ch of text) if (rules.script.test(ch)) n++;
  return n;
}

const JUNK_TOKEN = /^[|\\/[\]{}()“”"'`~=_+*#@§®©<>:;,.\-—–]+$/u;
const KEEP_TOKEN = /^(\.{2,}|…|[!?]+|[!?]*\.{3}[!?]*)$/u;
const SINGLE_LETTERS = new Set(['I', 'A', 'a', 'O', 'o', 'y', 'à', 'e', 'é', 'Y', 'E', 'É', 'À', 'u', 'U']);

/** Removes OCR debris from Latin-script text: lone bars, brackets, quotes… */
export function stripJunkTokens(text: string): string {
  return text
    .split(' ')
    .filter((tok) => {
      if (!tok) return false;
      if (KEEP_TOKEN.test(tok)) return true;
      if (JUNK_TOKEN.test(tok)) return false;
      const letters = tok.replace(/[^\p{L}]/gu, '');
      if (letters.length === 1 && !/\d/.test(tok) && !SINGLE_LETTERS.has(letters)) return false;
      return true;
    })
    .join(' ');
}

const VOWEL = /[aeiouyàáâãäåæèéêëìíîïòóôõöøœùúûüýÿ]/i;

/** Share of tokens that look like real words (Latin scripts); 1 for other scripts. */
export function plausibility(text: string, rules: LangRules): number {
  if (!isLatin(rules)) return 1;
  // Hyphens join stutters ("R-REALLY", "I-I") into one word.
  const words = text.match(/\p{L}[\p{L}'’-]*/gu) ?? [];
  if (words.length === 0) return 0;
  const ok = words.filter((w) => (w.length >= 2 && VOWEL.test(w)) || SINGLE_LETTERS.has(w)).length;
  return ok / words.length;
}

/**
 * Short, unsure fragments are almost always art misread as text
 * ("Vy", "fl", "27 Mg"…). Real lettering is either long or read with high
 * confidence.
 */
export function isNoiseBlock(text: string, confidence: number, rules: LangRules): boolean {
  const letters = scriptLetters(text, rules);
  if (isLatin(rules)) {
    if (letters < 3 && confidence < 90) return true;
    if (letters < 6 && confidence < 75) return true;
    return plausibility(text, rules) < 0.6;
  }
  return letters < 2 && confidence < 85;
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

// --- language detection -----------------------------------------------------------

export interface ScriptStats {
  hangul: number;
  kana: number;
  han: number;
  latin: number;
  cyrillic: number;
  thai: number;
}

export function scriptStats(text: string): ScriptStats {
  const s: ScriptStats = { hangul: 0, kana: 0, han: 0, latin: 0, cyrillic: 0, thai: 0 };
  for (const ch of text) {
    if (/[가-힯ᄀ-ᇿ㄰-㆏]/u.test(ch)) s.hangul++;
    else if (/[぀-ヿㇰ-ㇿｦ-ﾟ]/u.test(ch)) s.kana++;
    else if (/[一-鿿㐀-䶿豈-﫿]/u.test(ch)) s.han++;
    else if (/[A-Za-zÀ-ɏḀ-ỿ]/u.test(ch)) s.latin++;
    else if (/[Ѐ-ӿ]/u.test(ch)) s.cyrillic++;
    else if (/[฀-๿]/u.test(ch)) s.thai++;
  }
  return s;
}

export type Script = 'ko' | 'ja' | 'zh' | 'latin' | 'ru' | 'th';

/** Dominant writing system of an OCR sample, or null when there is too little text. */
export function classifyScript(text: string): Script | null {
  const s = scriptStats(text);
  const total = s.hangul + s.kana + s.han + s.latin + s.cyrillic + s.thai;
  if (total < 4) return null;
  const cjk = s.hangul + s.kana + s.han;
  // Korean comics may contain a few hanja, Japanese ones a lot of kanji:
  // Hangul or kana are the reliable markers.
  if (s.hangul >= Math.max(3, cjk * 0.3)) return 'ko';
  if (s.kana >= Math.max(2, cjk * 0.1)) return 'ja';
  if (s.han >= Math.max(3, total * 0.4)) return 'zh';
  if (s.cyrillic >= total * 0.5) return 'ru';
  if (s.thai >= total * 0.5) return 'th';
  if (s.latin >= total * 0.5) return 'latin';
  return null;
}

const STOPWORDS: Record<string, string[]> = {
  en: ['the', 'you', 'and', 'is', 'to', 'what', 'are', 'it', 'this', 'that', 'i', 'me', 'my', 'of', 'do', "don't", 'we', 'for', 'have', 'was'],
  fr: ['le', 'la', 'les', 'de', 'des', 'et', 'est', 'je', 'tu', 'vous', 'pas', 'que', 'qui', 'un', 'une', 'ce', 'mais', 'moi', 'toi', 'nous', "c'est", 'pour'],
  es: ['el', 'la', 'los', 'las', 'de', 'que', 'y', 'es', 'yo', 'tú', 'no', 'por', 'qué', 'un', 'una', 'estoy', 'pero', 'eso', 'para', 'con', 'está'],
  pt: ['o', 'a', 'os', 'as', 'de', 'que', 'e', 'é', 'eu', 'você', 'não', 'um', 'uma', 'isso', 'mas', 'para', 'com', 'está', 'meu', 'em'],
  it: ['il', 'lo', 'la', 'gli', 'di', 'che', 'e', 'è', 'io', 'tu', 'non', 'un', 'una', 'ma', 'per', 'sono', 'questo', 'cosa', 'mi', 'ti'],
  de: ['der', 'die', 'das', 'und', 'ist', 'ich', 'du', 'nicht', 'ein', 'eine', 'was', 'wir', 'sie', 'es', 'mit', 'zu', 'mir', 'dich', 'aber', 'sein'],
  id: ['yang', 'dan', 'aku', 'kamu', 'tidak', 'ini', 'itu', 'apa', 'di', 'ke', 'ada', 'saya', 'dia', 'kita', 'akan', 'sudah', 'bisa', 'juga'],
};

/** Guesses the language of Latin-script text from frequent words and diacritics. */
export function guessLatinLanguage(text: string): string {
  const lower = text.toLowerCase();
  // Vietnamese has letters no other supported language uses.
  if ((lower.match(/[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/g) ?? []).length >= 3) return 'vi';
  const words = lower.match(/[\p{L}']+/gu) ?? [];
  let best = 'en';
  let bestScore = 0;
  for (const [lang, list] of Object.entries(STOPWORDS)) {
    const set = new Set(list);
    let score = words.filter((w) => set.has(w)).length;
    if (lang === 'fr') score += (lower.match(/[àâçèéêëîïôûù]/g) ?? []).length * 0.3;
    if (lang === 'es') score += (lower.match(/[ñ¿¡áíóú]/g) ?? []).length * 0.3;
    if (lang === 'pt') score += (lower.match(/[ãõç]/g) ?? []).length * 0.5;
    if (lang === 'de') score += (lower.match(/[äöüß]/g) ?? []).length * 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = lang;
    }
  }
  return best;
}

/** Common comic sound effects (English lettering of webtoons and manga). */
const SFX_WORDS = new Set(
  (
    'huff puff pant gasp sigh gulp slurp lick slap smack spank thrust pound bang boom crash thud thump bump knock ' +
    'twitch tremble shiver shake quiver jolt jerk flinch grip grab clutch clasp squeeze squish squelch wriggle ' +
    'swoosh whoosh swish swing woosh fwoosh whip zip zoom dash rush spurt squirt splash splurt drip drop plop ' +
    'pop snap crack click clack tap tick tock ring ding beep buzz whirr rustle shuffle step stomp thwack whack ' +
    'smash crunch rip tear swell throb pulse thump-thump ba-dump badump kiss chu smooch muah slide flop toss ' +
    'turn stare glare blush flush shudder sniff sniffle sob hic cough ahem rumble growl roar hiss sizzle ' +
    'shlick schlick clench rub glance peek pout wink blink nod poof puff tzzt tzt zap zzz shake shiver ' +
    'squirm writhe jiggle bounce sway flutter flap pat poke pinch stroke tickle scratch wipe yank tug pull push ' +
    'shove press grasp clap clink clang clatter rattle creak thunk bonk boing splat splosh gush spray pump ' +
    'plap pap pomp slosh suck chomp munch nom gulp glug sip slurp kiss smooch lick sniff snore yawn ' +
    'bam pow wham kaboom boom thwip whiz zing ping ting tink chime ring vroom screech skid tremor quake'
  ).split(' '),
);

/** Cries and breaths: dialogue inside a bubble, drawn sound effects outside one. */
const CRY_WORDS = new Set(
  ('ha haa hah hahn haan ah ahh ahn aah ugh ugh hng hnn hnng nng ngh nngh mm mmm hmm oh ooh uh uhh huh ung eek ' +
    'kya kyaa ow ouch hyaa hyuu heh hehe kuh guh gah ack urk erk ngg fuu phew whew pant heave hic').split(' '),
);

/**
 * Lettering drawn outside the bubbles that is a sound effect, not a sign:
 * a known effect or cry ("HUFF", "HAAA!", "HNNG"), or one shouted word
 * with stretched letters or an exclamation ("SHLIIICK!").
 */
export function isDrawnEffect(text: string): boolean {
  if (isSoundEffect(text)) return true;
  const clean = text.replace(/[!?.…~♥♡*\-]+/g, ' ').trim();
  const words = clean.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 3) return false;
  const squeeze = (w: string) => w.replace(/(.)\1+/g, '$1');
  const cries = new Set([...CRY_WORDS].map(squeeze));
  if (words.every((w) => /^\p{L}+$/u.test(w) && (CRY_WORDS.has(w) || cries.has(squeeze(w))))) return true;
  // One word in capitals, letters stretched (three alike) or shouted.
  if (words.length === 1 && clean === clean.toLocaleUpperCase() && /^\p{L}{2,12}$/u.test(clean)) {
    if (/(\p{L})\1\1/iu.test(clean) || /!\s*$/.test(text)) return true;
  }
  return false;
}

/** Text that is a website's watermark ("TOOMICS.com", "manhwa18.net"), never story text. */
export function isWatermark(text: string): boolean {
  const t = text.trim();
  return (
    /\b[\p{L}\d-]{2,}\s?\.\s?(com|net|org|io|co|me|to|xyz|club|site|info|fun|cc|tv|gg)\b/iu.test(t) ||
    /\b(toomics|toongod|webtoons?|manhwa\s?\d*|scan(s|lation)?|mangadex|lezhin|tappytoon)\b/i.test(t) && t.split(/\s+/).length <= 3
  );
}

/**
 * Text that is only a drawn sound effect ("HUFF", "SLAP SLAP", "TWITCH!",
 * "SPUUURT"): one to three words, each a known effect (letters may be
 * stretched) or a word repeated.
 */
export function isSoundEffect(text: string): boolean {
  const words = text.toLowerCase().replace(/[!?.…~♥♡*\-]+/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 3) return false;
  const squeeze = (w: string) => w.replace(/(.)\1+/g, '$1');
  const known = new Set([...SFX_WORDS].map(squeeze));
  return words.every((w) => /^\p{L}+$/u.test(w) && (SFX_WORDS.has(w) || known.has(squeeze(w))));
}
