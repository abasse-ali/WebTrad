import { logInfo } from './log';
import { LLM_PRESETS, getSettings, updateSettings } from './settings';
import { quotaSpentSince } from './translate/llm';
import type { LlmSettings } from './types';

/**
 * When the day's free quota of the provider in use runs out, another
 * provider the user set up (its key saved in Réglages) takes over, and the
 * chapter goes on. OpenRouter's free models answer in 2 s but only so many
 * times a day; NVIDIA has no daily quota but takes 4 requests a minute.
 * Once spent, the chapter stopped, then every chapter waiting after it, at
 * its first page, until NVIDIA was chosen by hand.
 */

/** Providers tried in this order to take over (the others after them). */
const ORDER = ['nvidia', 'gemini', 'openrouter'];

const DAY = 86_400_000;

/**
 * When a provider's free quota is back: OpenRouter's at midnight UTC,
 * Google's at midnight Pacific time (08:00 UTC at the latest), any other a
 * day later.
 */
export function quotaBackAt(preset: string, now = Date.now()): number {
  if (preset === 'openrouter') return (Math.floor(now / DAY) + 1) * DAY;
  if (preset === 'gemini') {
    const today8 = Math.floor(now / DAY) * DAY + 8 * 3_600_000;
    return now < today8 ? today8 : today8 + DAY;
  }
  return now + DAY;
}

const base = (url: string) => url.trim().replace(/\/+$/, '');

/** The settings with `preset` in use, the current provider kept among the saved ones. */
function switched(llm: LlmSettings, preset: string, resume?: LlmSettings['resume']): LlmSettings {
  const p = LLM_PRESETS.find((x) => x.id === preset);
  const saved = { ...(llm.saved ?? {}), [llm.preset]: { apiKey: llm.apiKey, model: llm.model, baseUrl: llm.baseUrl, proofModel: llm.proofModel } };
  const back = saved[preset];
  return {
    preset,
    baseUrl: back?.baseUrl || p?.baseUrl || llm.baseUrl,
    apiKey: back?.apiKey ?? '',
    model: back?.model || p?.model || llm.model,
    proofModel: back?.proofModel,
    saved,
    resume,
  };
}

function labelOf(preset: string): string {
  return LLM_PRESETS.find((p) => p.id === preset)?.label ?? preset;
}

/**
 * The quota of the day is spent at the provider in use: the first saved
 * provider with a key (and a model reading images, in AI reading) takes
 * over. Its label, or undefined when none can. When another request already
 * switched (two pages refused at once), the provider now in use.
 */
export function switchToBackup(now = Date.now()): string | undefined {
  const settings = getSettings();
  const llm = settings.llm;
  if (!quotaSpentSince(llm.baseUrl)) return labelOf(llm.preset);
  const vision = settings.ocrEngine === 'vision';
  const ids = [...ORDER, ...LLM_PRESETS.map((p) => p.id).filter((id) => !ORDER.includes(id))];
  const next = ids.find((id) => {
    const p = LLM_PRESETS.find((x) => x.id === id);
    const s = llm.saved?.[id];
    if (!p || id === llm.preset || !s?.apiKey.trim() || (vision && !p.vision)) return false;
    return !quotaSpentSince(s.baseUrl || p.baseUrl) && base(s.baseUrl || p.baseUrl) !== base(llm.baseUrl);
  });
  if (!next) return undefined;
  // The first provider is taken back when its quota is, not the one in between.
  const resume = llm.resume ?? { preset: llm.preset, at: quotaBackAt(llm.preset, now) };
  updateSettings({ llm: switched(llm, next, resume) });
  return labelOf(next);
}

/**
 * Back to the provider whose quota ran out, once it is renewed (at the
 * start of a chapter). Its label when it is taken back.
 */
export function resumeAfterQuota(now = Date.now()): string | undefined {
  const llm = getSettings().llm;
  const r = llm.resume;
  if (!r || now < r.at) return undefined;
  if (r.preset === llm.preset || !llm.saved?.[r.preset]?.apiKey.trim()) {
    updateSettings({ llm: { ...llm, resume: undefined } });
    return undefined;
  }
  updateSettings({ llm: switched(llm, r.preset) });
  logInfo('job', `Quota du jour renouvelé : retour à ${labelOf(r.preset)}`);
  return labelOf(r.preset);
}
