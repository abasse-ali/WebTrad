import { beforeEach, describe, expect, it, vi } from 'vitest';
import { castOf, charactersFor, rememberSpeakers, speakerKey } from '../src/lib/cast';
import { speakerOf } from '../src/lib/translate/llm';
import { readable } from '../src/lib/speakers';
import { prosody, speakerOfBubble, spokenText, voiceForSpeaker, voicesFor } from '../src/lib/voices';
import type { Bubble } from '../src/lib/types';

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});
beforeEach(() => store.clear());

const voice = (name: string, lang = 'fr-FR') => ({ name, voiceURI: `com.apple.voice.compact.${lang}.${name}`, lang, localService: true, default: false }) as SpeechSynthesisVoice;
const all = [voice('Thomas'), voice('Amélie', 'fr-CA'), voice('Audrey (Enhanced)'), voice('Jacques'), voice('Bells'), voice('Samantha', 'en-US')];
const fr = voicesFor(all, 'fr');
const TITLE = 'Read Someone Stop Her! Chapter 108 Online';
const b = (over: Partial<Bubble>): Bubble => ({ id: Math.random().toString(36), x: 0, y: 0, w: 100, h: 40, original: '', translation: 'Salut.', ...over });

describe('device voices', () => {
  it('keeps the voices of the language, by gender, best first, without novelty voices', () => {
    expect(fr.map((v) => v.voice.name)).toEqual(['Audrey (Enhanced)', 'Thomas', 'Amélie', 'Jacques']);
    expect(fr.map((v) => v.gender)).toEqual(['female', 'male', 'female', 'male']);
  });
});

describe('a voice per character', () => {
  it('gives each character a voice of their gender, kept from one bubble to the next', () => {
    const mina = voiceForSpeaker(TITLE, 'mina', 'female', fr);
    const boss = voiceForSpeaker(TITLE, 'masked man', 'male', fr);
    const nurse = voiceForSpeaker(TITLE, 'pink haired nurse', 'female', fr);
    expect(fr.find((v) => v.voice === mina.voice)?.gender).toBe('female');
    expect(fr.find((v) => v.voice === boss.voice)?.gender).toBe('male');
    // Two women: two different voices while there are.
    expect(nurse.voice).not.toBe(mina.voice);
    expect(voiceForSpeaker(TITLE, 'mina', undefined, fr).voice).toBe(mina.voice);
  });

  it('shares a voice with another pitch once every voice is taken', () => {
    const picks = ['a', 'b', 'c'].map((k) => voiceForSpeaker(TITLE, k, 'female', fr));
    expect(picks[2].voice).toBe(picks[0].voice);
    expect(picks[2].pitch).not.toBe(picks[0].pitch);
  });

  it('raises a man voice for a woman when the device has no woman voice', () => {
    const men = voicesFor([voice('Thomas')], 'fr');
    expect(voiceForSpeaker(TITLE, 'mina', 'female', men).pitch).toBeGreaterThan(1.2);
  });

  it('reads narration with the narrator voice', () => {
    expect(speakerOfBubble(b({ kind: 'narration', speaker: 'narrator' }))).toBe('');
    expect(speakerOfBubble(b({ speaker: 'The Masked Man', gender: 'male' }))).toBe('masked man');
  });
});

describe('what is said and how', () => {
  it('says lettering in capitals in sentence case (not spelt out)', () => {
    expect(spokenText('TAIS-TOI ! LAISSE-MOI ME CONCENTRER !')).toBe('Tais-toi ! Laisse-moi me concentrer !');
    expect(spokenText('« Bonjour »')).toBe('Bonjour');
  });

  it('says a shout faster and higher, a thought softer', () => {
    const base = { pitch: 1, rate: 1, volume: 1 };
    const shout = prosody('Arrête !!', 'dialogue', base);
    expect(shout.rate).toBeGreaterThan(1);
    expect(shout.pitch).toBeGreaterThan(1);
    expect(prosody('Je me demande…', 'thought', base).volume).toBeLessThan(1);
  });

  it('reads bubbles top to bottom, side by side from the left, without hidden ones', () => {
    const list = readable([
      b({ id: '3', y: 500 }),
      b({ id: '2', x: 300, y: 100 }),
      b({ id: '1', x: 10, y: 110 }),
      b({ id: 'x', y: 50, hidden: true }),
      b({ id: 'y', y: 60, translation: '…' }),
    ]);
    expect(list.map((x) => x.id)).toEqual(['1', '2', '3']);
  });
});

describe('the cast of a series', () => {
  it('counts characters across chapters and lists them for the AI', () => {
    rememberSpeakers(TITLE, [b({ speaker: 'Mina', gender: 'female' }), b({ speaker: 'Mina' }), b({ speaker: 'The masked man', gender: 'male' }), b({ speaker: 'narrator' })]);
    rememberSpeakers('Read Someone Stop Her! Chapter 109 Online', [b({ speaker: 'masked man' })]);
    expect(castOf(TITLE).map((m) => [m.key, m.seen])).toEqual([
      ['mina', 2],
      ['masked man', 2],
    ]);
    expect(charactersFor(TITLE)).toBe('- Mina (female)\n- The masked man (male)');
    expect(speakerKey('The  Masked-Man')).toBe('masked man');
  });

  it('reads the speaker fields of the AI', () => {
    expect(speakerOf({ speaker: ' Mina ', gender: 'Female', kind: 'thought' })).toEqual({ speaker: 'Mina', gender: 'female', kind: 'thought' });
    expect(speakerOf({ speaker: 'unknown', gender: 'unknown' })).toEqual({ speaker: undefined, gender: undefined, kind: undefined });
  });
});
