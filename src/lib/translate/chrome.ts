import { chromeCode } from '../languages';
import { TranslateError, type TranslationEngine } from './types';

/**
 * Translator API built into recent Chromium browsers (Chrome / Edge 138+).
 * Runs on-device: free, private and offline once the language pack is
 * downloaded. https://developer.chrome.com/docs/ai/translator-api
 */
type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

interface BuiltinTranslator {
  translate(text: string, options?: { signal?: AbortSignal }): Promise<string>;
  destroy?(): void;
}

interface TranslatorStatic {
  availability(opts: { sourceLanguage: string; targetLanguage: string }): Promise<Availability>;
  create(opts: {
    sourceLanguage: string;
    targetLanguage: string;
    monitor?: (m: EventTarget) => void;
  }): Promise<BuiltinTranslator>;
}

function api(): TranslatorStatic | null {
  const t = (globalThis as unknown as { Translator?: TranslatorStatic }).Translator;
  return t && typeof t.create === 'function' ? t : null;
}

export function hasBuiltinTranslator(): boolean {
  return api() !== null;
}

const instances = new Map<string, Promise<BuiltinTranslator>>();

export async function builtinAvailability(source: string, target: string): Promise<Availability> {
  const t = api();
  if (!t) return 'unavailable';
  try {
    return await t.availability({ sourceLanguage: chromeCode(source), targetLanguage: chromeCode(target) });
  } catch {
    return 'unavailable';
  }
}

/**
 * Creates (and downloads if needed) the translator. Call it from a click
 * handler: browsers require a user gesture before downloading a model.
 */
export function prepareBuiltin(source: string, target: string, onProgress?: (ratio: number) => void): Promise<BuiltinTranslator> {
  const key = `${source}>${target}`;
  let instance = instances.get(key);
  if (!instance) {
    const t = api();
    if (!t) return Promise.reject(new TranslateError('Built-in translator not supported', 'chrome', false));
    instance = t.create({
      sourceLanguage: chromeCode(source),
      targetLanguage: chromeCode(target),
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => onProgress?.((e as ProgressEvent).loaded));
      },
    });
    instances.set(key, instance);
    instance.catch(() => instances.delete(key));
  }
  return instance;
}

export const builtinEngine: TranslationEngine = {
  id: 'chrome',
  async translate({ texts, source, target, signal }) {
    const availability = await builtinAvailability(source, target);
    if (availability === 'unavailable') {
      throw new TranslateError(`Built-in translator: ${source} → ${target} unavailable`, 'chrome', false);
    }
    const translator = await prepareBuiltin(source, target);
    const out: string[] = [];
    for (const text of texts) out.push(await translator.translate(text, { signal }));
    return out;
  },
};
