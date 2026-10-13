import { googleCode } from '../languages';
import { TranslateError, type TranslationEngine } from './types';

/**
 * Google Translate through the free, key-less endpoint used by browser
 * extensions. Unofficial: it may be rate limited, hence the fallbacks.
 */
const ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
const MAX_QUERY = 5000; // URL-encoded characters per request

async function call(text: string, sl: string, tl: string, signal?: AbortSignal): Promise<string> {
  const params = new URLSearchParams({ client: 'gtx', sl, tl, dt: 't', q: text });
  const res = await fetch(`${ENDPOINT}?${params}`, { signal });
  if (!res.ok) throw new TranslateError(`Google Translate HTTP ${res.status}`, 'google', res.status !== 400);
  const data = (await res.json()) as [[string, string][]];
  if (!Array.isArray(data?.[0])) throw new TranslateError('Unexpected Google Translate response', 'google');
  return data[0].map((seg) => seg?.[0] ?? '').join('');
}

export const googleEngine: TranslationEngine = {
  id: 'google',
  async translate({ texts, source, target, signal }) {
    const sl = googleCode(source);
    const tl = googleCode(target);
    const out: string[] = new Array(texts.length).fill('');
    // Batch several bubbles per request, one per line, to save round trips.
    let batch: number[] = [];
    let size = 0;
    const flush = async () => {
      if (batch.length === 0) return;
      const items = batch;
      batch = [];
      size = 0;
      const joined = items.map((i) => texts[i].replace(/\s*\n\s*/g, ' ')).join('\n');
      const result = (await call(joined, sl, tl, signal)).split('\n');
      if (result.length === items.length) {
        items.forEach((idx, k) => (out[idx] = result[k].trim()));
      } else {
        // Line count changed: translate each bubble on its own.
        for (const idx of items) out[idx] = (await call(texts[idx], sl, tl, signal)).trim();
      }
    };
    for (let i = 0; i < texts.length; i++) {
      const cost = encodeURIComponent(texts[i]).length + 3;
      if (size + cost > MAX_QUERY) await flush();
      batch.push(i);
      size += cost;
    }
    await flush();
    return out;
  },
};
