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
/** Translators that finished loading: usable without waiting. */
const ready = new Set<string>();

/** The browser API sometimes never answers (no model service, stalled download…). */
const AVAILABILITY_TIMEOUT = 4000;
const CREATE_TIMEOUT = 30_000;
const DOWNLOAD_TIMEOUT = 10 * 60_000;

/** Rejects with `error()` when `promise` has not settled after `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, error: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(error()), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export async function builtinAvailability(source: string, target: string): Promise<Availability> {
  const t = api();
  if (!t) return 'unavailable';
  try {
    return await withTimeout(
      t.availability({ sourceLanguage: chromeCode(source), targetLanguage: chromeCode(target) }),
      AVAILABILITY_TIMEOUT,
      () => new Error('timeout'),
    );
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
    instance.then(
      () => ready.add(key),
      () => instances.delete(key),
    );
  }
  return instance;
}

/**
 * `waitForDownload`: the user picked this engine explicitly, so a missing
 * language pack is worth waiting for. In the automatic chain it is not:
 * another engine translates while the pack downloads in the background.
 */
function makeEngine(waitForDownload: boolean): TranslationEngine {
  return {
    id: 'chrome',
    async translate({ texts, source, target, signal }) {
      const key = `${source}>${target}`;
      let timeout = CREATE_TIMEOUT;
      if (!ready.has(key)) {
        const availability = await builtinAvailability(source, target);
        if (availability === 'unavailable') {
          throw new TranslateError(`Built-in translator: ${source} → ${target} unavailable`, 'chrome', false);
        }
        if (availability !== 'available') {
          if (!waitForDownload) {
            // Fetch the pack in the background (the browser refuses without a
            // recent click, which is fine) instead of freezing the chapter.
            prepareBuiltin(source, target).catch(() => undefined);
            throw new TranslateError('Built-in translator: language pack not downloaded yet', 'chrome');
          }
          timeout = DOWNLOAD_TIMEOUT;
        }
      }
      const translator = await withTimeout(
        prepareBuiltin(source, target),
        timeout,
        () => new TranslateError('Built-in translator did not start', 'chrome'),
      );
      const out: string[] = [];
      for (const text of texts) out.push(await translator.translate(text, { signal }));
      return out;
    },
  };
}

export const builtinEngine = makeEngine(false);
export const builtinOnlyEngine = makeEngine(true);
