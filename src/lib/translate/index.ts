import { logInfo, logWarn, since } from '../log';
import { getSettings } from '../settings';
import type { ProviderId } from '../types';
import { builtinEngine, builtinOnlyEngine, hasBuiltinTranslator, prepareBuiltin } from './chrome';
import { googleEngine } from './google';
import { llmEngine } from './llm';
import { myMemoryEngine } from './mymemory';
import { TranslateError, type TranslationEngine } from './types';

export { TranslateError } from './types';

function engineChain(provider: ProviderId): TranslationEngine[] {
  switch (provider) {
    case 'chrome':
      return [builtinOnlyEngine];
    case 'google':
      return [googleEngine, myMemoryEngine];
    case 'mymemory':
      return [myMemoryEngine];
    case 'llm':
      // If the AI endpoint fails (quota, offline…) keep going with free engines.
      return [llmEngine(), googleEngine, myMemoryEngine];
    case 'auto':
    default:
      return hasBuiltinTranslator() ? [builtinEngine, googleEngine, myMemoryEngine] : [googleEngine, myMemoryEngine];
  }
}

/** Engines that failed for good during this session (e.g. pair unsupported). */
const disabled = new Set<string>();
const cache = new Map<string, string>();

export interface TranslateResult {
  translations: string[];
  engine: string;
}

/**
 * Translates a list of bubble texts, trying each engine of the chain until
 * one succeeds. Identical texts are translated only once per session.
 */
export async function translateTexts(
  texts: string[],
  source: string,
  target: string,
  signal?: AbortSignal,
  provider: ProviderId = getSettings().provider,
): Promise<TranslateResult> {
  const keyOf = (t: string) => `${provider}|${source}|${target}|${t}`;
  const missing = [...new Set(texts.filter((t) => t.trim() && !cache.has(keyOf(t))))];
  let engineUsed = 'cache';
  if (missing.length > 0) {
    const errors: string[] = [];
    let done = false;
    for (const engine of engineChain(provider)) {
      const pairKey = `${engine.id}|${source}|${target}`;
      if (disabled.has(pairKey)) continue;
      for (let attempt = 0; ; attempt++) {
        const start = performance.now();
        try {
          const out = await engine.translate({ texts: missing, source, target, signal });
          logInfo('translate', `Traduction de ${missing.length} texte(s) par ${engine.id}`, { de: source, vers: target, ms: since(start) });
          missing.forEach((t, i) => {
            if (out[i]) cache.set(keyOf(t), out[i]);
          });
          engineUsed = engine.id;
          done = true;
          break;
        } catch (err) {
          if ((err as Error).name === 'AbortError') throw err;
          // The AI refused for going too fast: asked again once its pause is
          // over (the next request waits for it), instead of handing the line
          // to a word-for-word translator ("Ack!" became "Ouf !").
          if (engine.id === 'llm' && /HTTP 429/.test((err as Error).message) && attempt < 3) continue;
          errors.push((err as Error).message);
          logWarn('translate', `${engine.id} a échoué : ${(err as Error).message}`, { de: source, vers: target, ms: since(start) });
          if (err instanceof TranslateError && !err.retryable) disabled.add(pairKey);
          break;
        }
      }
      if (done) break;
    }
    if (!done) throw new TranslateError(errors.join(' · ') || 'No translation engine available', 'all');
  }
  return { translations: texts.map((t) => (t.trim() ? (cache.get(keyOf(t)) ?? '') : '')), engine: engineUsed };
}

/**
 * Must be called synchronously from a user gesture (button click): the
 * browser only lets a page download an on-device model after a gesture.
 */
export function warmUpTranslator(source: string, target: string, onProgress?: (ratio: number) => void): void {
  const { provider } = getSettings();
  if ((provider === 'auto' || provider === 'chrome') && hasBuiltinTranslator() && source !== 'auto') {
    // Start the creation right now, while the gesture is still active. An
    // unsupported pair simply rejects and the engine chain falls back.
    prepareBuiltin(source, target, onProgress).catch(() => undefined);
  }
}

export { hasBuiltinTranslator };
