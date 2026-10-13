import { getSettings } from '../settings';
import type { ProviderId } from '../types';
import { builtinEngine, hasBuiltinTranslator, prepareBuiltin } from './chrome';
import { googleEngine } from './google';
import { llmEngine } from './llm';
import { myMemoryEngine } from './mymemory';
import { TranslateError, type TranslationEngine } from './types';

export { TranslateError } from './types';

function engineChain(provider: ProviderId): TranslationEngine[] {
  switch (provider) {
    case 'chrome':
      return [builtinEngine];
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
      try {
        const out = await engine.translate({ texts: missing, source, target, signal });
        missing.forEach((t, i) => {
          if (out[i]) cache.set(keyOf(t), out[i]);
        });
        engineUsed = engine.id;
        done = true;
        break;
      } catch (err) {
        if ((err as Error).name === 'AbortError') throw err;
        errors.push((err as Error).message);
        if (err instanceof TranslateError && !err.retryable) disabled.add(pairKey);
      }
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
  if ((provider === 'auto' || provider === 'chrome') && hasBuiltinTranslator()) {
    // Start the creation right now, while the gesture is still active. An
    // unsupported pair simply rejects and the engine chain falls back.
    prepareBuiltin(source, target, onProgress).catch(() => undefined);
  }
}

export { hasBuiltinTranslator };
