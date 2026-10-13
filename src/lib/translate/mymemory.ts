import { getSettings } from '../settings';
import { googleCode } from '../languages';
import { TranslateError, type TranslationEngine } from './types';

/**
 * MyMemory free API: 5 000 characters/day anonymously, 50 000 with an e-mail.
 * Each request is limited to 500 bytes, so long texts are split by sentence.
 */
const ENDPOINT = 'https://api.mymemory.translated.net/get';

function chunks(text: string, maxBytes = 450): string[] {
  const enc = new TextEncoder();
  if (enc.encode(text).length <= maxBytes) return [text];
  const parts = text.match(/[^.!?。！？…]+[.!?。！？…]*\s*/gu) ?? [text];
  const out: string[] = [];
  let cur = '';
  for (const part of parts) {
    if (enc.encode(cur + part).length > maxBytes && cur) {
      out.push(cur);
      cur = '';
    }
    cur += part;
  }
  if (cur) out.push(cur);
  return out;
}

export const myMemoryEngine: TranslationEngine = {
  id: 'mymemory',
  async translate({ texts, source, target, signal }) {
    const email = getSettings().myMemoryEmail.trim();
    const out: string[] = [];
    for (const text of texts) {
      let translated = '';
      for (const chunk of chunks(text)) {
        const from = source === 'auto' ? 'Autodetect' : googleCode(source);
        const params = new URLSearchParams({ q: chunk, langpair: `${from}|${googleCode(target)}` });
        if (email) params.set('de', email);
        const res = await fetch(`${ENDPOINT}?${params}`, { signal });
        if (!res.ok) throw new TranslateError(`MyMemory HTTP ${res.status}`, 'mymemory');
        const data = (await res.json()) as {
          responseStatus: number | string;
          responseDetails?: string;
          responseData?: { translatedText?: string };
          quotaFinished?: boolean;
        };
        if (Number(data.responseStatus) !== 200 || data.quotaFinished) {
          throw new TranslateError(`MyMemory: ${data.responseDetails ?? data.responseStatus}`, 'mymemory', false);
        }
        translated += (translated ? ' ' : '') + (data.responseData?.translatedText ?? '');
      }
      out.push(translated.trim());
    }
    return out;
  },
};
