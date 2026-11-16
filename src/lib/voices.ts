/**
 * Reading aloud with the voices of the device (speech synthesis): each
 * character gets a voice of their gender, and a pitch of their own when two
 * share a voice; narration has a calm voice of its own. The voice given to a
 * character is kept in the series' cast (cast.ts).
 */
import { castOf, isNarrator, speakerKey, updateMember } from './cast';
import type { Bubble } from './types';

export type Gender = 'male' | 'female';

export interface VoiceInfo {
  voice: SpeechSynthesisVoice;
  gender?: Gender;
  /** 3 premium, 2 enhanced, 1 on the device, 0 other. */
  quality: number;
}

export interface Pick {
  voice?: SpeechSynthesisVoice;
  pitch: number;
  rate: number;
  volume: number;
}

// Voice names of iOS, macOS, Android and Windows, by gender. "Female" holds
// "male": the female test goes first.
const FEMALE =
  /\b(female|femme|woman|amélie|amelie|aurélie|aurelie|audrey|marie|julie|denise|hortense|eloise|éloïse|brigitte|céline|celine|léa|chantal|sylvie|virginie|coralie|joséphine|josephine|vivienne|ariane|sylvie|samantha|karen|moira|tessa|fiona|victoria|allison|ava|susan|zoe|zoé|serena|kate|vicki|veena|nicky|flo|sandy|shelley|grandma|catherine|paola|alice|anna|helena|sara|ellen|isabelle|claire|jenny|aria|emma|libby|sonia|natasha|clara|yuna|kyoko|o-ren|sora|meijia|tingting|sinji|mei-jia|ting-ting|google français)\b/i;
const MALE =
  /\b(male|homme|man|thomas|nicolas|daniel|henri|paul|jacques|claude|antoine|alain|sébastien|sebastien|jérôme|jerome|rémi|remy|fred|alex|aaron|arthur|rishi|tom|gordon|lee|oliver|evan|nathan|eddy|reed|rocko|grandpa|jorge|diego|luca|xander|yuri|guy|ryan|eric|davis|tony|brian|george|otoya|hattori|ichiro|minsu)\b/i;
// Novelty voices of Apple systems: never given to a character.
const NOVELTY = /\b(bells|bubbles|boing|bahh|cellos|organ|zarvox|trinoids|whisper|wobble|jester|superstar|bad news|good news|albert|junior|ralph|kathy|princess|deranged|hysterical)\b/i;

function genderOf(v: SpeechSynthesisVoice): Gender | undefined {
  const name = `${v.name} ${v.voiceURI}`;
  if (FEMALE.test(name)) return 'female';
  if (MALE.test(name)) return 'male';
  return undefined;
}

function qualityOf(v: SpeechSynthesisVoice): number {
  const name = `${v.name} ${v.voiceURI}`;
  if (/premium/i.test(name)) return 3;
  if (/enhanced|améliorée|natural|neural|online/i.test(name)) return 2;
  return v.localService ? 1 : 0;
}

export function speechAvailable(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
}

/** The voices of the device, loaded (they arrive a moment after start on some systems). */
export async function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  if (!speechAvailable()) return [];
  const now = speechSynthesis.getVoices();
  if (now.length > 0) return now;
  return new Promise((resolve) => {
    const done = () => resolve(speechSynthesis.getVoices());
    speechSynthesis.addEventListener('voiceschanged', done, { once: true });
    setTimeout(done, 1500);
  });
}

/** Voices for a language ("fr"), best first. */
export function voicesFor(all: SpeechSynthesisVoice[], lang: string): VoiceInfo[] {
  const base = lang.toLowerCase().split(/[-_]/)[0];
  return all
    .filter((v) => v.lang.toLowerCase().replace('_', '-').split('-')[0] === base && !NOVELTY.test(v.name))
    .map((voice) => ({ voice, gender: genderOf(voice), quality: qualityOf(voice) }))
    .sort((a, b) => b.quality - a.quality);
}

/** Pitches given in turn to the characters sharing a voice. */
const PITCHES = [1, 1.14, 0.88, 1.24, 0.8, 1.07, 0.94];

/** Who speaks a bubble, as a cast key ("" for the narrator). */
export function speakerOfBubble(b: Bubble): string {
  if (b.kind === 'narration' || b.kind === 'sign' || isNarrator(b.speaker)) return b.gender && !b.kind ? `?${b.gender}` : '';
  return speakerKey(b.speaker!);
}

/**
 * The voice of a speaker, given once and kept: a voice of their gender used
 * by the fewest characters of the series, the best one first, with a pitch
 * of their own when it is shared. Without a voice of that gender, another
 * voice raised or lowered.
 */
export function voiceForSpeaker(title: string, key: string, gender: Gender | undefined, voices: VoiceInfo[], label?: string): Pick {
  const base = { rate: 1, volume: 1 };
  if (voices.length === 0) return { ...base, pitch: 1 };
  const cast = castOf(title);
  const member = key && !key.startsWith('?') ? cast.find((m) => m.key === key) : undefined;
  const sex = member?.gender ?? gender;
  if (member?.voice) {
    const kept = voices.find((v) => v.voice.name === member.voice);
    if (kept) return { ...base, voice: kept.voice, pitch: member.pitch ?? 1 };
  }
  // The narrator: the best voice, calm, never shifted.
  if (!key) {
    const narrator = voices.find((v) => v.gender === 'male') ?? voices[0];
    return { voice: narrator.voice, pitch: 0.96, rate: 0.96, volume: 1 };
  }
  const pool = sex ? voices.filter((v) => v.gender === sex) : voices.filter((v) => !v.gender);
  const usable = pool.length > 0 ? pool : sex ? [] : voices;
  let pick: Pick;
  if (usable.length === 0) {
    // No voice of that gender on the device: another one, raised or lowered.
    const other = voices[0];
    pick = { ...base, voice: other.voice, pitch: sex === 'female' ? 1.3 : 0.75 };
  } else {
    // The least used voice (by the characters already given one), the best first.
    const uses = (v: VoiceInfo) => cast.filter((m) => m.voice === v.voice.name).length;
    const voice = [...usable].sort((a, b) => uses(a) - uses(b) || b.quality - a.quality)[0];
    const pitch = PITCHES[uses(voice) % PITCHES.length];
    pick = { ...base, voice: voice.voice, pitch };
  }
  // Remembered for the next bubbles and chapters (not for the "?female" speakers without a name).
  if (!key.startsWith('?')) updateMember(title, key, { voice: pick.voice?.name, pitch: pick.pitch, ...(sex ? { gender: sex } : {}) }, label);
  return pick;
}

/**
 * The tone of one line: a shout a little faster and higher, a question a
 * little higher, trailing dots slower, a thought softer.
 */
export function prosody(text: string, kind: Bubble['kind'], pick: Pick): Pick {
  let { pitch, rate, volume } = pick;
  const t = text.trim();
  if (/!\s*[!?]*\s*$/.test(t) || /!{2,}/.test(t)) {
    rate *= 1.08;
    pitch *= 1.05;
  } else if (/\?\s*$/.test(t)) pitch *= 1.03;
  if (/(…|\.\.\.)\s*[!?]?\s*$/.test(t)) rate *= 0.92;
  if (kind === 'thought') {
    rate *= 0.95;
    volume *= 0.8;
  }
  return { voice: pick.voice, pitch: Math.min(2, Math.max(0.5, pitch)), rate: Math.min(1.6, Math.max(0.6, rate)), volume };
}

/**
 * Text as a voice should say it: lettering is in capitals, which voices
 * spell out as acronyms ("TAIS-TOI" → "T, A, I, S"); it becomes sentence
 * case. Quotes and stray marks go.
 */
export function spokenText(text: string): string {
  let t = text.replace(/\s+/g, ' ').replace(/[«»“”"]/g, '').trim();
  const letters = t.replace(/[^\p{L}]/gu, '');
  if (letters.length > 1 && letters === letters.toLocaleUpperCase()) {
    t = t.toLocaleLowerCase().replace(/(^|[.!?…]\s+)(\p{L})/gu, (_, a: string, b: string) => a + b.toLocaleUpperCase());
    // "i" alone is "I" in English.
    t = t.replace(/\bi\b/g, 'I');
  }
  return t;
}

/** Says one line; resolves when it is said (or cut short by `signal`). */
export function speak(text: string, lang: string, pick: Pick, rateScale: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (!speechAvailable() || signal.aborted || !text) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = pick.voice?.lang ?? lang;
    if (pick.voice) u.voice = pick.voice;
    u.pitch = pick.pitch;
    u.rate = Math.min(2, Math.max(0.5, pick.rate * rateScale));
    u.volume = pick.volume;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      resolve();
    };
    const stop = () => {
      speechSynthesis.cancel();
      finish();
    };
    // Some systems never say the end of a line: a generous time limit.
    const timer = setTimeout(finish, 4000 + (text.length * 160) / u.rate);
    u.onend = finish;
    u.onerror = finish;
    signal.addEventListener('abort', stop, { once: true });
    // Kept reachable until it is said (some browsers drop it otherwise).
    (speak as unknown as { last?: SpeechSynthesisUtterance }).last = u;
    speechSynthesis.speak(u);
  });
}

/** Wakes speech up from the tap itself: iOS says nothing started later, after an await. */
export function unlockSpeech(): void {
  if (!speechAvailable()) return;
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0;
  speechSynthesis.speak(u);
}

export function stopSpeaking(): void {
  if (speechAvailable()) speechSynthesis.cancel();
}
