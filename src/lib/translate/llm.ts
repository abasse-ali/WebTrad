import { countRequest } from '../usage';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { englishName } from '../languages';
import { tidyTranslation } from '../text';
import { logError, logInfo, logWarn, since } from '../log';
import { LLM_PRESETS, getSettings } from '../settings';
import type { LlmSettings } from '../types';
import { TranslateError, type TranslationEngine } from './types';

/**
 * Any OpenAI-compatible chat completions endpoint: Gemini (free tier),
 * Groq, OpenRouter free models, or a local Ollama / LM Studio server.
 * The API key never leaves the browser except to call that endpoint.
 */

type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

interface RawResponse {
  status: number;
  text: string;
}

/**
 * One HTTP call to the AI provider. The iPhone app goes through the phone's
 * own network stack: providers that refuse calls from web pages (CORS, e.g.
 * NVIDIA) still answer it. The web version uses fetch.
 */
async function call(method: 'GET' | 'POST', url: string, headers: Record<string, string>, body?: unknown, signal?: AbortSignal): Promise<RawResponse> {
  if (Capacitor.isNativePlatform()) {
    const res = await CapacitorHttp.request({
      url,
      method,
      headers,
      data: body,
      responseType: 'text',
      // Free tiers queue a request for a while before they start to answer.
      connectTimeout: 60_000,
      // Reset by every chunk received: with a streamed answer a slow model never times out while it writes.
      readTimeout: 300_000,
    });
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return { status: res.status, text: typeof res.data === 'string' ? res.data : JSON.stringify(res.data) };
  }
  const res = await fetch(url, { method, headers, signal, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
}

function authHeaders(llm: LlmSettings): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (llm.apiKey.trim()) headers.Authorization = `Bearer ${llm.apiKey.trim()}`;
  return headers;
}

function baseOf(llm: LlmSettings): string {
  return llm.baseUrl.trim().replace(/\/+$/, '');
}

/** Refusals for too many requests in a row, per provider. */
const limitedStreak = new Map<string, number>();
let lastLimited = 0;

/** When a provider last refused a request for going too fast (ms since 1970, 0 if never). */
export function lastRateLimitAt(): number {
  return lastLimited;
}

/** Time before which no request goes to a provider (ms since 1970), after a 429. */
const cooldowns = new Map<string, number>();

/** How long to wait after a 429: until the provider's reset time if it gave one. */
export function rateLimitWait(body: string, now = Date.now()): number {
  const reset = Number(body.match(/"X-RateLimit-Reset"\s*:\s*"?(\d{10,13})/i)?.[1]);
  if (reset) {
    const at = reset < 1e12 ? reset * 1000 : reset;
    // A little margin; never less than 2 s nor more than 70 s (clocks may differ).
    return Math.min(70_000, Math.max(2_000, at - now + 1_000));
  }
  const after = Number(body.match(/retry[-_ ]after"?\s*[:=]\s*"?(\d+(?:\.\d+)?)/i)?.[1]);
  if (after) return Math.min(70_000, Math.max(2_000, after * 1000));
  // No reset time given (NVIDIA): a short pause, doubled by each refusal in
  // a row. The provider answers about 4 to 5 requests a minute whatever the
  // pace (refused every half minute at 27 a minute and at 5 alike); pauses
  // of 20 to 80 s after each refusal were most of the time a chapter took.
  return 8_000;
}

/**
 * Refusals that no pause or new try can fix, explained to the user: the
 * day's free quota is spent (waiting a minute only repeats the refusal for
 * hours), the key is refused, or the model is gone. The chapter stops on
 * them instead of putting every page in error, one request after another.
 */
/** Message of a request refused by the provider's content filter. */
export const CONTENT_REFUSED = 'Refused by the content filter of the AI provider';

/** A provider's content filter refused the request ("input rejected by content safety screening"). */
export function isContentRefusal(text: string): boolean {
  return /content[ _-]?(safety|filter|policy|moderation)|safety (screening|system|filter)|moderation|flagged|inappropriate content|prohibited content/i.test(text);
}

export function fatalReason(status: number, body: string): string | undefined {
  if (status === 429 && /per[-_ ]day|daily/i.test(body))
    return 'Quota gratuit du jour épuisé chez ce fournisseur : reprenez demain, ou choisissez un autre fournisseur (par exemple NVIDIA) dans Réglages.';
  if (status === 401 || (status === 403 && !/region/i.test(body)))
    return 'Clé API absente ou refusée par le fournisseur : vérifiez-la dans Réglages.';
  if (status === 403) return 'Ce modèle n’est pas disponible dans votre région : choisissez-en un autre dans Réglages.';
  if ((status === 404 && /model|unavailable|not found|no endpoints/i.test(body)) || status === 410)
    return 'Ce modèle n’est plus disponible (ou plus gratuit) : choisissez-en un autre dans Réglages.';
  return undefined;
}

function limitOf(body: string): string | undefined {
  return body.match(/"X-RateLimit-Limit"\s*:\s*"?(\d+)/i)?.[1];
}

/**
 * Requests per minute a provider accepts, learnt from its refusals (NVIDIA
 * says nothing of its limit): the next requests are spaced to stay under
 * it, instead of being refused and paused again and again. Remembered from
 * one chapter (and one launch of the app) to the next: each chapter began
 * at full speed and was refused within a minute.
 */
const learntLimit = new Map<string, { limit: number; at: number; refusedAt: number }>();
const PACE_KEY = 'webtrad.rateLimits.v2';
/** Never spaced more than this (requests a minute): a key slowed by the provider still goes on. */
const MIN_LIMIT = 4;

function saveLimits(): void {
  try {
    const out: Record<string, { limit: number; refusedAt: number; at: number }> = {};
    for (const [host, l] of learntLimit) out[host] = { limit: limitFor(host) ?? l.limit, refusedAt: l.refusedAt, at: Date.now() };
    localStorage.setItem(PACE_KEY, JSON.stringify(out));
  } catch {
    /* storage refused: learnt again next time */
  }
}

(function loadLimits() {
  try {
    const saved = JSON.parse(localStorage.getItem(PACE_KEY) ?? '{}') as Record<string, { limit: number; refusedAt: number; at: number }>;
    for (const [host, l] of Object.entries(saved)) {
      // Two hours later the provider may have changed its mind: learnt again.
      // (Kept a day, a pace of 4 a minute learnt one evening slowed every
      // chapter of the next day as well.)
      if (Date.now() - l.at > 2 * 3_600_000 || !(l.limit > 0)) continue;
      learntLimit.set(host, { limit: l.limit, refusedAt: l.refusedAt, at: Date.now() });
    }
  } catch {
    /* nothing saved */
  }
})();

/**
 * The per-minute limit in force for a host. A limit learnt from a refusal
 * may be too strict (a burst at startup, a busy moment): each two minutes
 * without a new refusal allow one more request, never up to the rate that
 * was refused (it climbed back and was refused again, each time with a
 * pause) unless ten quiet minutes went by; past 60 the limit goes.
 */
function limitFor(host: string, now = Date.now()): number | undefined {
  const known = knownLimit(host);
  const learnt = learntLimit.get(host);
  if (!learnt) return known;
  const quiet = now - learnt.at;
  const cap = Math.max(learnt.limit, learnt.refusedAt - 1 + Math.floor(quiet / 600_000));
  const limit = Math.min(learnt.limit + Math.floor(quiet / 120_000), cap);
  if (limit > Math.min(60, known ?? Infinity)) {
    learntLimit.delete(host);
    return known;
  }
  return limit;
}

/**
 * Providers whose free limit is known: requests are spaced under it from the
 * start. NVIDIA allows 40 a minute; going over it once (two pages at a time
 * answered in 3 s) brought refusals every 20 s for the rest of the chapter.
 */
export function knownLimit(key: string): number | undefined {
  const host = key.split('|')[0];
  if (/(^|\.)nvidia\.com$/i.test(host)) return 30;
  return undefined;
}
const recentStarts = new Map<string, number[]>();
/** When the requests the provider answered were sent, per host. */
const recentAccepted = new Map<string, number[]>();

function startsInLastMinute(host: string, now = Date.now()): number[] {
  const list = (recentStarts.get(host) ?? []).filter((t) => now - t < 60_000);
  recentStarts.set(host, list);
  return list;
}

function acceptedInLastMinute(host: string, now = Date.now()): number[] {
  const list = (recentAccepted.get(host) ?? []).filter((t) => now - t < 60_000);
  recentAccepted.set(host, list);
  return list;
}

/** A request sent at `at` was answered (not refused for going too fast). */
export function noteAccepted(host: string, at = Date.now()): void {
  acceptedInLastMinute(host).push(at);
}

/** Waits for a free slot under the learnt per-minute limit, then books it. */
export async function paceRequest(host: string, signal?: AbortSignal): Promise<void> {
  for (;;) {
    const list = startsInLastMinute(host);
    const limit = limitFor(host);
    const now = Date.now();
    // Evenly spaced, not in bursts: the provider refused the third of three
    // requests sent in the same second, though far under its limit a minute.
    const gap = limit && learntLimit.has(host) ? 60_000 / limit : 0;
    const last = list[list.length - 1] ?? -Infinity;
    if (!limit || (list.length < limit && now - last >= gap)) {
      list.push(now);
      return;
    }
    const wait = Math.max(list.length < limit ? last + gap - now : list[0] + 60_000 - now + 200, 50);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, wait);
      signal?.addEventListener('abort', () => (clearTimeout(timer), reject(new DOMException('Aborted', 'AbortError'))), { once: true });
    });
  }
}

/**
 * Remembers the rate a provider refused at: what it answered in the minute
 * before the refusal is what it takes. NVIDIA, spaced at 8 a minute, took
 * two requests in three and refused the third, all chapter long (each
 * refusal a pause): it answers about 5 to 6 a minute.
 */
export function learnLimit(host: string, said?: number): void {
  const now = Date.now();
  const current = limitFor(host, now) ?? Infinity;
  const accepted = acceptedInLastMinute(host, now).length;
  const limit = said && said < 1000 ? said : Math.max(MIN_LIMIT, Math.min(accepted, current - 1));
  learntLimit.set(host, { limit: Math.min(current, limit), at: now, refusedAt: Math.max(MIN_LIMIT + 1, Number.isFinite(current) ? current : limit + 1) });
  saveLimits();
}

/** Milliseconds left before requests to any provider may go again. */
export function cooldownLeft(): number {
  return Math.max(0, ...[...cooldowns.values()].map((t) => t - Date.now()));
}

async function waitForCooldown(host: string, signal?: AbortSignal): Promise<void> {
  const wait = (cooldowns.get(host) ?? 0) - Date.now();
  if (wait <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, wait);
    signal?.addEventListener('abort', () => (clearTimeout(timer), reject(new DOMException('Aborted', 'AbortError'))), { once: true });
  });
}

/**
 * Longest wait for one complete answer of the provider. Answers take 2 to
 * 30 s (a page, a chapter's proofreading); one not there after 90 s does
 * not come (NVIDIA once held two requests 3 minutes each, three times over).
 */
const REQUEST_DEADLINE_MS = 90_000;

async function request(llm: LlmSettings, method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  let res: RawResponse;
  const host = (() => {
    try {
      return new URL(baseOf(llm)).host;
    } catch {
      return baseOf(llm);
    }
  })();
  const model = (body as { model?: string } | undefined)?.model;
  // NVIDIA counts its limit per model: the proofreading model's requests
  // (and its refusals) no longer slow the reading of the pages, which waited
  // on the same budget and the same pauses.
  const pace = model ? `${host}|${model}` : host;
  // A rate limit was hit: every request waits for the provider's window to reset.
  await waitForCooldown(pace, signal);
  if (path === '/chat/completions') await paceRequest(pace, signal);
  const sentAt = Date.now();
  // Timed after the pause: the log shows how long the provider took.
  const start = performance.now();
  const images = JSON.stringify((body as { messages?: unknown } | undefined)?.messages ?? '').split('"type":"image_url"').length - 1;
  try {
    // A stream that trickles for a quarter of an hour blocks the whole page:
    // past the deadline the request is given up and tried again.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no complete answer after ${REQUEST_DEADLINE_MS / 1000} s`)), REQUEST_DEADLINE_MS);
    });
    try {
      res = await Promise.race([call(method, `${baseOf(llm)}${path}`, authHeaders(llm), body, signal), deadline]);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      logInfo('ia', `${method} ${path} annulé`, { fournisseur: host, modèle: model, ms: since(start) });
      throw err;
    }
    logError('ia', `${method} ${path} injoignable : ${(err as Error).message}`, { fournisseur: host, modèle: model, ms: since(start) });
    const hint = Capacitor.isNativePlatform()
      ? 'Check the URL and the network.'
      : 'Check the URL. If the provider refuses calls from web pages (CORS, e.g. NVIDIA), use the iPhone app.';
    throw new TranslateError(`AI endpoint unreachable (${(err as Error).message}). ${hint}`, 'llm');
  }
  const meta = { fournisseur: host, modèle: model, statut: res.status, ms: since(start), images: images || undefined, octets: res.text.length };
  if (path === '/chat/completions') countRequest(host, res.status === 429 ? 'limited' : res.status >= 200 && res.status < 300 ? 'ok' : 'failed');
  const fatal = fatalReason(res.status, res.text);
  if (fatal) {
    logError('ia', `${method} ${path} → HTTP ${res.status} : ${fatal}`, meta);
    throw new TranslateError(`${fatal} (HTTP ${res.status})`, 'llm', false, true);
  }
  if (res.status === 429) {
    // Refused again and again right after each pause (NVIDIA, once a key has
    // gone over its limit, refused one request in two for 40 minutes): each
    // refusal in a row doubles the pause, up to 2 minutes, instead of asking
    // again every 20 s and keeping the provider's penalty going.
    const streak = (limitedStreak.get(pace) ?? 0) + 1;
    limitedStreak.set(pace, streak);
    lastLimited = Date.now();
    const waitMs = Math.min(120_000, rateLimitWait(res.text) * 2 ** Math.min(3, streak - 1));
    cooldowns.set(pace, Math.max(cooldowns.get(pace) ?? 0, Date.now() + waitMs));
    learnLimit(pace, Number(limitOf(res.text)) || undefined);
    logWarn(
      'ia',
      `Limite de requêtes atteinte : pause de ${Math.round(waitMs / 1000)} s, puis ${limitFor(pace)} requêtes par minute au plus` +
        (streak >= 3 ? ` (${streak} refus de suite : le fournisseur ralentit cette clé, les pages passent une par une)` : ''),
      { ...meta, refus: streak },
    );
    throw new TranslateError(`AI endpoint HTTP 429 (rate limit) ${res.text.slice(0, 200)}`, 'llm', true);
  }
  if (res.status < 200 || res.status >= 300) {
    logError('ia', `${method} ${path} → HTTP ${res.status} : ${res.text.slice(0, 160)}`, meta);
    // An image the provider's content filter refuses: asking again changes nothing.
    // Not when the filter itself is down for a moment ("content safety screening is
    // temporarily unavailable", HTTP 503): that is asked again, like any outage.
    if (res.status < 500 && isContentRefusal(res.text)) throw new TranslateError(`${CONTENT_REFUSED} (HTTP ${res.status})`, 'llm', false);
    throw new TranslateError(`AI endpoint HTTP ${res.status} ${res.text.slice(0, 300)}`, 'llm', res.status === 429 || res.status >= 500);
  }
  limitedStreak.delete(pace);
  if (path === '/chat/completions') noteAccepted(pace, sentAt);
  if (/^\s*(data:|event:|:)/.test(res.text)) {
    const parsed = parseStream(res.text);
    // Thinking models write their reasoning first: long, slow, and unused.
    logInfo('ia', `${method} ${path} OK`, { ...meta, réflexion: parsed.reasoning || undefined });
    return parsed;
  }
  logInfo('ia', `${method} ${path} OK`, meta);
  try {
    return JSON.parse(res.text);
  } catch {
    throw new TranslateError('AI answer is not valid JSON', 'llm');
  }
}

/**
 * Rebuilds a chat answer from a streamed one (server-sent events): the
 * pieces of `choices[0].delta.content` put back together.
 */
export function parseStream(text: string): { choices: { message: { content: string } }[]; reasoning: number } {
  let content = '';
  let reasoning = 0;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^data:\s*(.*)$/);
    if (!m || m[1] === '[DONE]' || !m[1].trim()) continue;
    let event: {
      error?: { message?: string } | string;
      choices?: { delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown }; message?: { content?: unknown } }[];
    };
    try {
      event = JSON.parse(m[1]);
    } catch {
      continue;
    }
    if (event.error) {
      const message = typeof event.error === 'string' ? event.error : (event.error.message ?? 'error');
      throw new TranslateError(`AI endpoint: ${message}`, 'llm');
    }
    const choice = event.choices?.[0];
    const piece = choice?.delta?.content ?? choice?.message?.content;
    if (typeof piece === 'string') content += piece;
    const thought = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
    if (typeof thought === 'string') reasoning += thought.length;
  }
  return { choices: [{ message: { content } }], reasoning };
}

export interface ModelInfo {
  id: string;
  /** Reads images (needed by the AI OCR mode). */
  vision: boolean;
  /** Free to use (only known for providers that publish prices, e.g. OpenRouter). */
  free?: boolean;
}

/** Names of models that read images, as providers publish them. */
const VISION_NAME =
  /(\bvl\b|-vl|vl-|vision|multimodal|qwen3\.5|qwen3-vl|qwen2\.5-vl|llama-4|gemma-3|pixtral|mistral-(large|medium|small)-3|kimi-k2\.5|kimi-vl|llava|paligemma|neva|kosmos|fuyu|cosmos-reason|nemotron.*vl|gemini|glm-4\.\dv|internvl|minicpm-v|phi-4-multimodal)/i;
/** Models that are not chat models at all (embeddings, safety filters, rerankers…). */
const NOT_CHAT = /(embed|rerank|retriev|guard|safety|reward|moderation|whisper|tts|asr|parakeet|canary|nv-clip|dinov|ocdrnet|nemoretriever|paddleocr|parse|detector|grounding-dino|deplot|sdxl|flux|stable-diffusion|cosmos-predict|audio)/i;

/** Models the key gives access to, sorted by name; image readers flagged. */
export async function listModels(llm: LlmSettings): Promise<ModelInfo[]> {
  if (!baseOf(llm)) throw new TranslateError('AI engine not configured', 'llm', false);
  const data = (await request(llm, 'GET', '/models')) as {
    data?: {
      id?: string;
      architecture?: { input_modalities?: string[]; output_modalities?: string[]; modality?: string };
      pricing?: { prompt?: string | number; completion?: string | number };
    }[];
  };
  return (data.data ?? [])
    // Music or picture generators (they answer with sound, not text).
    .filter((m) => m.id && !NOT_CHAT.test(m.id) && (m.architecture?.output_modalities?.includes('text') ?? true))
    .map((m) => {
      const id = m.id!;
      // OpenRouter says what each model takes and costs; others only have names.
      const inputs = m.architecture?.input_modalities ?? (m.architecture?.modality ? m.architecture.modality.split('->')[0].split('+') : undefined);
      const vision = inputs ? inputs.includes('image') : VISION_NAME.test(id);
      const free = m.pricing ? Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0 : id.endsWith(':free') ? true : undefined;
      return { id, vision, free };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Text models that proofread French best among those a free NVIDIA key
 * offers, best first. The provider retires models without notice (Qwen 3.5
 * answered "410 Gone" for a whole chapter's proofreading): the first one
 * of the list the account still has is taken.
 */
const PROOF_MODELS = [
  /qwen3\.[5-9][^/]*-(?:397|235|480)b/i,
  /qwen3-235b/i,
  /deepseek-v(?:3\.[1-9]|[4-9])/i,
  /kimi-k2/i,
  /mistral-large/i,
  /mistral-medium/i,
  /gpt-oss-120b/i,
  /llama-4-maverick/i,
  /nemotron[^/]*ultra/i,
];
/** Thinking, coding or image models: slow or no better at French. */
const NOT_PROOF = /r1|qwq|think|reason|coder|-vl|vision|guard|embed|distill/i;
const PROOF_KEY = 'webtrad.proofModel.v1';

/** Forgets the proofreading model chosen (it was retired). */
export function forgetProofModel(): void {
  try {
    localStorage.removeItem(PROOF_KEY);
  } catch {
    /* nothing kept */
  }
}

/**
 * The model that proofreads for this provider when none is set: chosen
 * among the account's models (kept three days). Undefined when the list
 * cannot be read or holds none of them.
 */
export async function proofModelFor(llm: LlmSettings, gone: Set<string> = new Set()): Promise<string | undefined> {
  if (llm.preset !== 'nvidia') return undefined;
  try {
    const kept = JSON.parse(localStorage.getItem(PROOF_KEY) ?? 'null') as { base: string; model: string; at: number } | null;
    if (kept && kept.base === baseOf(llm) && Date.now() - kept.at < 3 * 86_400_000 && !gone.has(kept.model)) return kept.model;
  } catch {
    /* chosen again */
  }
  const ids = (await listModels(llm)).map((m) => m.id).filter((id) => !NOT_PROOF.test(id) && !gone.has(id));
  for (const pattern of PROOF_MODELS) {
    // The newest of a family ("v3.2" after "v3.1").
    const id = ids.filter((m) => pattern.test(m)).sort().pop();
    if (!id) continue;
    try {
      localStorage.setItem(PROOF_KEY, JSON.stringify({ base: baseOf(llm), model: id, at: Date.now() }));
    } catch {
      /* chosen again next time */
    }
    return id;
  }
  return undefined;
}

/** A 200×70 image reading "HELLO", to check that a model really reads images. */
const HELLO_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMgAAABGCAAAAACsiYTqAAACN0lEQVR42mP8zzA8ABPDqEdGPTLqkVGPjHpk1COjHhn1yKhHRj0y6pFRj4x6ZNQjox4Z9QidPRLAyMjIyMj4Bi4gwMjIyMiogyKLBApwaMMrzMDAwPB2VY65sgCbuJZH65F/FHqEZeDC8EH3vB8MDAwMDK9eXd/JoFoazzY0k9Y8zWk/kLi308zvDkmPZCf/QBO5YHJ4CHqkYxqm2IfA+wPgkdf/4WAC6boPV0OzaOahNz8eLTaDZv6gf0MtRqohLhY6Ps1WmF025gTUXxdWDjGPHILkBsY1JhA+Y0s0hNEyxDyyEUIFO8JFeiFl77W7Q8sjeyFUEkJE3AdFhqoeEYVX3R/xysqQbOnfS5AEZY0kZgOhzg2pGHkLmV2S5kMS04QWhkPKI9B2lwCymACK1NBq/TJi4fwfUh4RhtbkyGLvoVmPBh5B1N38eGWfkO4RSPA//YwkdgNCiQypGGGBdG3+HUUSOwKhDIdWHnGBtuSRIngzisxQ8Yg/hFpzCC5S/IuBgYGBQUNlaHnEHlIV/g+G1n//GxZDGDVDrfXbCsnubyxyjr7/9WSZVSNEWDeSfCP/YwJ/7KWWNoosEuDGK4FdGGszV+j2f7LBQFWI1WmYYnxrVRiGWtJiYJg5gx1NRPeMw5AcRUm/ms6BxFWeflqVorpp4JpayjNa9hw68/rtd0EhOVt7a2YKG26j67VGPTLqkVGPjHpk1COjHhn1yKhHRj0y6pFRj4x6ZNQjox4Z9cioR4gAAFvf+KMHO9kOAAAAAElFTkSuQmCC';

export interface ModelCheck {
  model: string;
  ok: boolean;
  /** Answer time in milliseconds. */
  ms: number;
  error?: string;
}

/** Asks `model` to read a small image: does it answer, read it right, and how fast. */
export async function checkVisionModel(llm: LlmSettings, model: string, timeoutMs = 60_000): Promise<ModelCheck> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const answer = await Promise.race([
      chat(
        { ...llm, model },
        [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What word is written in this image? Answer with the word only.' },
              { type: 'image_url', image_url: { url: HELLO_IMAGE } },
            ],
          },
        ],
        controller.signal,
      ),
      new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true })),
    ]);
    const ok = /hello/i.test(answer);
    return { model, ok, ms: Date.now() - start, error: ok ? undefined : `« ${answer.trim().slice(0, 40)} »` };
  } catch (err) {
    return { model, ok: false, ms: Date.now() - start, error: (err as Error).message.slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

const thinkingOptionRefused = new Set<string>();

/**
 * Turns off the "thinking" of reasoning models (NVIDIA's Nemotron and
 * others): they wrote pages of reasoning before every answer, which made a
 * page take a minute instead of a few seconds, for no better reading.
 */
export function noThinking(llm: LlmSettings): Record<string, unknown> {
  const base = baseOf(llm);
  if (thinkingOptionRefused.has(base)) return {};
  if (/nvidia\.com/i.test(base)) return { chat_template_kwargs: { enable_thinking: false, thinking: false } };
  if (/openrouter\.ai/i.test(base)) return { reasoning: { enabled: false } };
  return {};
}

export async function chat(llm: LlmSettings, messages: ChatMessage[], signal?: AbortSignal, maxTokens?: number): Promise<string> {
  if (!baseOf(llm) || !llm.model.trim()) throw new TranslateError('AI engine not configured', 'llm', false);
  // A cap on the answer: free models sometimes repeat one line forever (the
  // same "LET'S GO!" fifteen times, 196 made-up texts, 900 KB in 90 s). The
  // answer is cut there; its complete items are kept (see salvageItems).
  const limit = maxTokens ? { max_tokens: maxTokens } : {};
  const data = (await request(
    llm,
    'POST',
    '/chat/completions',
    // Streamed: data keeps flowing while a big model writes a long answer,
    // instead of one silent wait that ends in a timeout.
    { model: llm.model.trim(), temperature: 0.2, messages, stream: true, ...limit, ...noThinking(llm) },
    signal,
  ).catch(async (err: Error) => {
    // A provider that refuses the option: asked again without it, and never
    // again once that works. Not for a refusal of the content itself: a page
    // NVIDIA's filter rejected turned the option off, and every page after it
    // took a minute again.
    if (!/HTTP 4(00|22)/.test(err.message) || err.message.startsWith(CONTENT_REFUSED) || !Object.keys(noThinking(llm)).length) throw err;
    const answer = await request(llm, 'POST', '/chat/completions', { model: llm.model.trim(), temperature: 0.2, messages, stream: true, ...limit }, signal);
    thinkingOptionRefused.add(baseOf(llm));
    return answer;
  })) as { choices?: { message?: { content?: string | { text?: string }[] } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => p.text ?? '').join('');
  throw new TranslateError('Empty AI response', 'llm');
}

/** Extracts the first JSON value from a model answer (handles ``` fences and chatter). */
export function parseJsonAnswer<T>(answer: string): T {
  const fenced = answer.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : answer).trim();
  try {
    return JSON.parse(body) as T;
  } catch {
    const start = body.search(/[[{]/);
    if (start >= 0) {
      const open = body[start];
      const close = open === '{' ? '}' : ']';
      const end = body.lastIndexOf(close);
      if (end > start) {
        try {
          return JSON.parse(body.slice(start, end + 1)) as T;
        } catch {
          /* salvaged below */
        }
      }
    }
    // Quotes left unescaped inside a text ("text":"Dis "salut" !"): the most
    // common damage; once escaped the whole answer usually reads.
    const repaired = escapeInnerQuotes(body);
    if (repaired !== body) {
      try {
        return parseJsonAnswer<T>(repaired);
      } catch {
        /* salvaged below */
      }
    }
    // Cut or damaged answers (free models stop mid-way): keep the complete items.
    const items = salvageItems(body);
    // Under the name each caller reads (vision: "bubbles", translation: "translations").
    if (items.length > 0) return { bubbles: items, translations: items } as T;
    throw new TranslateError('AI answer is not valid JSON', 'llm');
  }
}

/** Escapes the bare quotes inside the "text" and "translation" values of a model's JSON. */
export function escapeInnerQuotes(body: string): string {
  return body.replace(/("(?:text|translation)"\s*:\s*")([\s\S]*?)("\s*(?:,\s*"[A-Za-z_]+"\s*:|\}))/g, (_, open: string, value: string, close: string) =>
    open + value.replace(/\\?"/g, '\\"') + close,
  );
}

/** The well-formed objects that carry a "translation" in a damaged JSON answer. */
export function salvageItems(body: string): unknown[] {
  const out: unknown[] = [];
  const stack: number[] = [];
  let inString = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') stack.push(i);
    else if (ch === '}' && stack.length > 0) {
      const from = stack.pop()!;
      const chunk = body.slice(from, i + 1);
      if (!/"(translation|text)"\s*:/.test(chunk)) continue;
      try {
        const item = JSON.parse(chunk) as { bubbles?: unknown };
        // An item, not the whole answer (which would have been parsed already).
        if (item && typeof item === 'object' && !('bubbles' in item)) out.push(item);
      } catch {
        /* skipped */
      }
    }
  }
  return out;
}

const SYSTEM_TRANSLATE = `You are an expert translator of manga, manhwa, manhua, webtoons and comics.
You receive the text of the speech bubbles of one page, in reading order. The text comes from OCR and may contain recognition errors: infer the intended words.
Translate every bubble naturally, the way a professional scanlation team would: short, spoken, faithful to tone and character voice. A sentence often runs over several bubbles: read them together so the translation flows in order. Translate the meaning, not word for word; rude stays rude, polite stays polite; keep the same form of address between the same characters. Keep names consistent, adapt interjections, do not add notes or explanations.
Answer with JSON only: {"translations":[{"id":<id>,"text":"<translation>"}]} with exactly one entry per input id.`;

export function llmEngine(llm: LlmSettings = getSettings().llm): TranslationEngine {
  return {
    id: 'llm',
    async translate({ texts, source, target, signal }) {
      if (texts.length === 0) return [];
      const payload = {
        source_language: englishName(source),
        target_language: englishName(target),
        bubbles: texts.map((text, i) => ({ id: i + 1, text })),
      };
      const answer = await chat(
        llm,
        [
          { role: 'system', content: SYSTEM_TRANSLATE },
          { role: 'user', content: JSON.stringify(payload) },
        ],
        signal,
      );
      const parsed = parseJsonAnswer<{ translations?: { id: number; text: string }[] } | { id: number; text: string }[]>(answer);
      const list = Array.isArray(parsed) ? parsed : (parsed.translations ?? []);
      const out = texts.map(() => '');
      for (const item of list) {
        const idx = Number(item?.id) - 1;
        if (idx >= 0 && idx < out.length && typeof item.text === 'string') out[idx] = item.text.trim();
      }
      if (out.every((t) => !t)) throw new TranslateError('AI answer had no translations', 'llm');
      return out;
    },
  };
}

// --- Proofreading: the translations of a chapter read again, text only ------

const SYSTEM_PROOFREAD = `You are the proofreader of a professional scanlation team. You receive the translated lines of a comic chapter, in reading order, each with its original text and, when known, who says it ("speaker", "gender").
Read the lines together, as a conversation, and fix every real mistake of the translation:
- spelling mistakes, typos, words that do not exist or are misused ("j'ai faut me faire prendre" or "j'ai faille" → "j'ai failli", "je cryais" → "je croyais", "pourquoi erais-je" → "pourquoi serais-je", "tu pense" → "tu penses", "t'es endormis" → "t'es endormi", "ces longues membres" → "ces longs membres", "lancé un sorte" → "lancé un sort", "ressents-je" → "ressens-je", "exité" → "excité");
- a word missing, the sentence broken ("o-on vraiment risquer" → "o-on pourrait vraiment risquer");
- agreement with the speaker's gender when they speak of themselves ("je suis sorti" said by a woman → "je suis sortie", "nu" → "nue"), and with the person spoken to or spoken of, as the lines around tell;
- a line wholly or partly left in the source language, translated ("O-OKAY…" → "D-D'ACCORD…", "WOW… NICE !" → "WOW… SUPER !"); names, nicknames, honorifics (noona, unnie) and sound effects stay;
- a cry translated by another feeling ("ACK!" (pain) → "AÏE !", not "OUF !"); "holy crap" → "putain" or "bordel", not "sacré merde";
- English turns of phrase translated word for word, put as a native speaker would say them ("that was close" → "c'était moins une", "morning after" (the pill) → "pilule du lendemain", "of all people" → "en plus", "good timing" → "pile au bon moment");
- a translation that says something else than its original, or the opposite (a negation lost, the wrong person: "can't wait to be a daddy, huh?!" said to him → "t'as hâte d'être papa, hein ?!");
- a word repeated by mistake, stray characters, missing French typography (a space before ? ! : ;).
Keep everything else as it is: tone, slang, swear words, about the same length, line breaks are not needed, the letter case of the line. Do not rephrase a line that is already correct and natural.
Answer with JSON only: {"fixes":[{"id":<id>,"text":"<corrected translation>"}]} listing only the lines you changed; {"fixes":[]} when all are correct.`;

/**
 * Lines of a chapter proofread by the AI (text only, a few requests per
 * chapter): the corrected translation of each line that had a mistake.
 */
export async function proofreadTexts(
  items: { id: number; original: string; text: string; speaker?: string; gender?: string }[],
  target: string,
  signal?: AbortSignal,
  llm: LlmSettings = getSettings().llm,
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (items.length === 0) return out;
  const payload = {
    target_language: englishName(target),
    lines: items.map((i) => ({
      id: i.id,
      ...(i.speaker ? { speaker: i.speaker } : {}),
      ...(i.gender ? { gender: i.gender } : {}),
      original: i.original,
      translation: i.text,
    })),
  };
  const answer = await chat(
    llm,
    [
      { role: 'system', content: SYSTEM_PROOFREAD },
      { role: 'user', content: JSON.stringify(payload) },
    ],
    signal,
  );
  type Fix = { id?: unknown; text?: unknown; translation?: unknown; corrected?: unknown };
  const parsed = parseJsonAnswer<Record<string, Fix[] | undefined> | Fix[]>(answer);
  // Models name things their own way: "fixes", "corrections", the lines sent back…
  const list = Array.isArray(parsed) ? parsed : (parsed.fixes ?? parsed.corrections ?? parsed.lines ?? parsed.translations ?? []);
  for (const fix of Array.isArray(list) ? list : []) {
    const id = Number(fix?.id);
    const k = items.findIndex((i) => i.id === id);
    const item = items[k];
    const value = fix?.text ?? fix?.corrected ?? fix?.translation;
    if (!item || typeof value !== 'string') continue;
    // A change of gender only where it is known who the words are about.
    const way = genderChange(item.text, value);
    if (way) {
      const near = [k - 1, k + 1, k - 2, k + 2].map((j) => items[j]).find((o) => o?.speaker && o.speaker !== item.speaker && o.gender);
      if (!genderFixAllowed(item.text, way, item.gender, near?.gender)) continue;
    }
    const text = acceptedFix(item.text, value);
    if (text) out.set(id, text);
  }
  return out;
}

/** Masculine and feminine endings of French words (fou/folle, sorti/sortie…). */
const GENDER_ENDINGS: [string, string][] = [
  ['teur', 'trice'],
  ['eaux', 'elles'],
  ['eux', 'euse'],
  ['eur', 'euse'],
  ['eau', 'elle'],
  ['ou', 'olle'],
  ['if', 'ive'],
  ['el', 'elle'],
  ['en', 'enne'],
  ['on', 'onne'],
  ['et', 'ette'],
  ['er', 'ère'],
  ['s', 'es'],
  ['', 'e'],
];

/** "f" when `b` is `a` made feminine, "m" when made masculine, null otherwise. */
function genderOf(a: string, b: string): 'f' | 'm' | null {
  for (const [m, f] of GENDER_ENDINGS) {
    if (a.endsWith(m) && a.length >= m.length + 1 && b === a.slice(0, a.length - m.length) + f) return 'f';
    if (b.endsWith(m) && b.length >= m.length + 1 && a === b.slice(0, b.length - m.length) + f) return 'm';
  }
  return null;
}

/**
 * The way a corrected line changes the gender of its words: "f" or "m"
 * when some words only changed gender (all the same way), null when none
 * did. Lines of a different number of words are not compared.
 */
export function genderChange(before: string, after: string): 'f' | 'm' | null {
  const words = (t: string) => t.toLocaleLowerCase().split(/[^\p{L}'’-]+/u).filter(Boolean);
  const a = words(before);
  const b = words(after);
  if (a.length !== b.length) return null;
  let way: 'f' | 'm' | null = null;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    const g = genderOf(a[i], b[i]);
    if (!g) continue;
    if (way && way !== g) return null;
    way = g;
  }
  return way;
}

/**
 * Whether a change of gender made by the proofreader is right, from who
 * the line is about: the speaker ("je"), the one spoken to ("tu", the
 * other speaker of the lines around), or "il"/"elle". Unknown: refused
 * (it turned "t'es complètement folle", said to a woman, into "fou", and
 * "d'être normale", said by her, into "normal").
 */
export function genderFixAllowed(line: string, way: 'f' | 'm', speaker?: string, addressee?: string): boolean {
  const t = ` ${line.toLocaleLowerCase().replace(/[’]/g, "'")} `;
  const want = (g?: string) => (g === 'female' ? 'f' : g === 'male' ? 'm' : null);
  const first = /[\s(«"-](je|j'|me|m'|moi)[\s,.!?…'-]/.test(t) || /\bj'/.test(t);
  const second = /[\s(«"-](tu|t'|te|toi|vous)[\s,.!?…'-]/.test(t) || /\bt'/.test(t);
  if (first && !second) return want(speaker) === way;
  if (second && !first) return want(addressee) === way;
  if (!first && !second) {
    if (/[\s(«"-]elles?[\s,.!?…'-]/.test(t) && !/[\s(«"-]ils?[\s,.!?…'-]/.test(t)) return way === 'f';
    if (/[\s(«"-]ils?[\s,.!?…'-]/.test(t) && !/[\s(«"-]elles?[\s,.!?…'-]/.test(t)) return way === 'm';
  }
  return false;
}

/** A proofread line, kept only when it is a correction, not a new line. */
export function acceptedFix(before: string, after: string): string | undefined {
  let text = tidyTranslation(after, before).replace(/\s+/g, ' ').trim();
  // The same words with the line breaks taken out is no correction (it was
  // logged as one, and the lines of the lettering were lost).
  const flat = before.replace(/\s+/g, ' ').trim();
  if (!text || text === flat) return undefined;
  // About the same length: a fix, not a rewrite (nor a line run into the next one).
  const ratio = text.length / Math.max(1, before.trim().length);
  if (ratio < 0.6 || ratio > 1.6) return undefined;
  // Lettering in capitals stays in capitals.
  const letters = before.replace(/[^\p{L}]/gu, '');
  if (letters.length > 1 && letters === letters.toLocaleUpperCase()) text = text.toLocaleUpperCase();
  return text === flat ? undefined : text;
}

// --- AI vision: read + translate a page image in a single request -----------

export type Gender = 'male' | 'female';
export type TextKind = 'dialogue' | 'thought' | 'narration' | 'sign';

export interface VisionBubble {
  /** Normalised 0–1000 box: [ymin, xmin, ymax, xmax]. */
  box: [number, number, number, number];
  text: string;
  translation: string;
  /** Who says it: a name, or a description that stays the same from page to page. */
  speaker?: string;
  gender?: Gender;
  kind?: TextKind;
  /** The model says it is a drawn sound effect: never lettered over. */
  sfx?: boolean;
}

/** The speaker fields of a model's item, cleaned. */
export function speakerOf(item: { speaker?: unknown; gender?: unknown; kind?: unknown; type?: unknown }): Pick<VisionBubble, 'speaker' | 'gender' | 'kind'> {
  const g = String(item.gender ?? '').toLowerCase();
  const k = String(item.kind ?? item.type ?? '').toLowerCase();
  const speaker = typeof item.speaker === 'string' ? item.speaker.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
  return {
    speaker: speaker && !/^(unknown|none|n\/a|\?+)$/i.test(speaker) ? speaker : undefined,
    gender: /^(m|male|man|homme|masculin)/.test(g) ? 'male' : /^(f|female|woman|femme|féminin)/.test(g) ? 'female' : undefined,
    kind: /^thought/.test(k) ? 'thought' : /^narrat/.test(k) ? 'narration' : /^(sign|screen|label|text)/.test(k) ? 'sign' : /^dialog|^speech/.test(k) ? 'dialogue' : undefined,
  };
}

const SPEAKER_RULES = `- "speaker": who says it, so that it can be read aloud with that character's voice. The character's name when the story gives it, else a short description of how they look that you would give again on every page ("masked man", "pink-haired nurse", "red-haired girl in a hoodie"). When a list of characters is given, reuse its labels exactly for the same people. Follow the tail of the bubble to the character. "narrator" for narration boxes, "sign" for written text in the scenery.
- "gender": "male", "female" or "unknown", the speaker's, from the drawing and the way they speak.
- "kind": "dialogue", "thought" (thought bubbles, inner voice), "narration", "sign", or "sfx" for a sound effect drawn on the artwork (DU-DOOM, BRUSH, DUN…) if you list one by mistake: it is never translated.`;

function visionPrompt(order: 'yxyx' | 'xyxy'): string {
  const box = order === 'xyxy' ? '[xmin, ymin, xmax, ymax]' : '[ymin, xmin, ymax, xmax]';
  const key = order === 'xyxy' ? 'bbox_2d' : 'box_2d';
  return `You are an expert manga, manhwa, manhua, webtoon and comics translator with perfect OCR skills.
Find every piece of story text in the image: speech bubbles, thought bubbles, narration boxes, and text written on objects or in the scenery (signs, screens, phones, letters, labels, posters). Ignore watermarks, page numbers, credits, the series logo or title artwork, and "to be continued" banners.
Do NOT include sound effects, onomatopoeia or cries drawn as artwork outside the speech bubbles (stylised, coloured or outlined letters on the drawing: HUFF, HAAA, HNNG, UGH, SHLICK…). Do NOT include website watermarks (TOOMICS.com…), even when they lie on a bubble. Sound effects are NEVER translated, whatever their size or colour, even with a hyphen (DU-DOOM, BA-DUMP) or several words: drawn effect words such as HUFF, SLAP, SMACK, TWITCH, SWOOSH, GRIP, THRUST, 쿵, 두근, ドキ, ゴゴゴ, 砰 must be left out entirely, even when they are big or in bubbles of their own.
For each one give its bounding box as ${box} normalised to 0-1000 (tight around the lettering), the exact original text, and a translation in the requested language.
How to translate, like a professional scanlation team:
- Read the whole image first: a sentence often runs over several bubbles; translate each bubble so that, read in order, they form natural sentences.
- Translate the meaning, not word for word. Use the words a native speaker would really say in that situation, short enough to fit the bubble.
- Keep each character's voice and register: rude stays rude (swear words stay swear words), polite stays polite, childish stays childish. Keep the same form of address (tu/vous, tutoiement…) between the same characters.
- Keep names, nicknames and usernames as they are; keep the gaming, internet and fandom words that readers of the target language use as they are (teamfight, carry, rank names…), translate the others.
- Interjections in bubbles (Ugh, Huh?, Haha, Hmm, Tch) become their usual equivalents in the target language; stuttering (I-I…, WH-WHAT, SH-SHE) is kept in the translation (in French: « M-mais… », « E-elle… »), and so are trailing dots (…).
- English idioms and exclamations are never translated word for word (in French: "Boy, am I in trouble" is « Bon sang, je suis dans le pétrin », "Holy shit!" is « Putain de merde ! », "Remember…" said to oneself is « Je me souviens… »). No word of the original language left in the translation (in French: boyfriend → petit ami, bastard → salaud), names apart.
- Use the typography of the target language (French: « » for quotes, a space before ? ! : ;).
- In languages that mark gender (French…), agree words with the gender of the speaker and of the person spoken to, as drawn (a woman says « je suis rentrée », « je suis prête »).
- Only text in the target language: no notes, no romanisation, no alternatives, no emoji or flags, no line breaks inside a translation.
- Every word in the target language and spelled right: translate slang and kids' words too (cooties → microbes), and read each translation again for typos before answering.
For each text also say who speaks it:
${SPEAKER_RULES}
Also give the language of the original text as an ISO 639-1 code ("ko", "ja", "zh-Hans", "zh-Hant", "en"…).
Only list text that is really drawn in this image: never add, guess or continue lines (the story so far is context only), and never repeat an item.
Answer with JSON only: {"source_language":"<code>","bubbles":[{"${key}":${box.replace(/ /g, '')},"kind":"dialogue|thought|narration|sign","speaker":"...","gender":"male|female|unknown","text":"...","translation":"..."}]} in reading order. List each piece of text once, one item per block of lettering: never split the lines of one block into several items, and never merge two separate blocks (two bubbles drawn touching or joined are two items). Return {"bubbles":[]} if there is no text.`;
}

/** Box order the configured provider is best at. */
function boxOrderOf(llm: LlmSettings): 'yxyx' | 'xyxy' {
  return LLM_PRESETS.find((p) => p.id === llm.preset)?.boxOrder ?? 'yxyx';
}

/**
 * Longest answer of the AI for one image. A busy page (26 texts) takes about
 * 2 500 tokens; past 4 000 the model is repeating itself.
 */
export const VISION_MAX_TOKENS = 4000;

export async function visionTranslate(
  imageDataUrl: string,
  source: string,
  target: string,
  signal?: AbortSignal,
  llm: LlmSettings = getSettings().llm,
  /** Size of the image sent: models that answer in pixels are brought back to 0-1000. */
  size?: { width: number; height: number },
  /** Lines translated just before (previous pages), for names, tone and the story so far. */
  context?: string,
  /** How the comic is read, when it is not a webtoon ("manga": right to left). */
  layout?: 'webtoon' | 'manga' | 'comic',
): Promise<{ bubbles: VisionBubble[]; sourceLanguage?: string }> {
  const order = boxOrderOf(llm);
  const answer = await chat(
    llm,
    [
      { role: 'system', content: visionPrompt(order) },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              (source === 'auto'
                ? `Detect the source language. Translate into ${englishName(target)}.`
                : `Source language: ${englishName(source)}. Translate into ${englishName(target)}.`) +
              (layout === 'manga'
                ? '\nThis is a manga: panels and bubbles are read from right to left, then top to bottom. List the texts in that order.'
                : layout === 'comic'
                  ? '\nThis is a comic: panels and bubbles are read from left to right, then top to bottom.'
                  : '') +
              (context
                ? `\nStory so far (the last bubbles before this image, original → translation). Use it for the context, names, form of address and tone; do not include these lines in your answer:\n${context}`
                : ''),
          },
          { type: 'image_url', image_url: { url: imageDataUrl } },
        ],
      },
    ],
    signal,
    VISION_MAX_TOKENS,
  );
  const parsed = parseJsonAnswer<{ bubbles?: unknown[]; source_language?: string } | unknown[]>(answer);
  const list = Array.isArray(parsed) ? parsed : (parsed.bubbles ?? []);
  const sourceLanguage = Array.isArray(parsed) ? undefined : parsed.source_language;
  const out: VisionBubble[] = [];
  type Item = { box_2d?: unknown; bbox_2d?: unknown; bbox?: unknown; box?: unknown; text?: unknown; translation?: unknown; kind?: unknown; type?: unknown; speaker?: unknown; gender?: unknown };
  const boxes: { box: number[]; xyxy: boolean; item: Item }[] = [];
  for (const raw of list) {
    const item = raw as Item;
    // Sound effects are left drawn as they are, whatever the model sent.
    if (/^(sfx|sound|onomatop)/i.test(String(item.kind ?? item.type ?? ''))) continue;
    // The key tells the order when the model picked its own habit.
    const xyxy = item.bbox_2d !== undefined || item.bbox !== undefined ? true : item.box_2d !== undefined ? false : order === 'xyxy';
    const box = (item.box_2d ?? item.bbox_2d ?? item.bbox ?? item.box) as unknown;
    if (!Array.isArray(box) || box.length !== 4 || !box.every((v) => typeof v === 'number')) continue;
    boxes.push({ box: box as number[], xyxy, item });
  }
  // Coordinates above 1000 are pixels of the image sent.
  const inPixels = size !== undefined && boxes.some((b) => b.box.some((v) => v > 1000));
  for (const { box, xyxy, item } of boxes) {
    let [y0, x0, y1, x1] = xyxy ? [box[1], box[0], box[3], box[2]] : box;
    if (inPixels && size) {
      y0 = (y0 / size.height) * 1000;
      y1 = (y1 / size.height) * 1000;
      x0 = (x0 / size.width) * 1000;
      x1 = (x1 / size.width) * 1000;
    }
    if (y1 <= y0 || x1 <= x0) continue;
    // The same text at the same place, sent again and again by a model in a loop.
    const text = typeof item.text === 'string' ? item.text : '';
    if (out.some((o) => o.text === text && Math.abs(o.box[0] - y0) < 15 && Math.abs(o.box[1] - x0) < 15)) continue;
    out.push({
      box: [y0, x0, y1, x1],
      text: typeof item.text === 'string' ? item.text : '',
      translation: typeof item.translation === 'string' ? tidyTranslation(item.translation, text) : '',
      ...speakerOf(item),
      ...(/^(sfx|sound|effect|onomat)/i.test(String(item.kind ?? item.type ?? '')) ? { sfx: true } : {}),
    });
  }
  return { bubbles: out, sourceLanguage };
}

/**
 * Who speaks each text of an image already translated (chapters read before
 * voices existed). The texts are numbered on the image itself, next to their
 * bubble, so the model ties each number to the character the tail points at.
 */
export async function identifySpeakers(
  imageDataUrl: string,
  texts: { id: number; text: string }[],
  characters: string | undefined,
  signal?: AbortSignal,
  llm: LlmSettings = getSettings().llm,
): Promise<Map<number, Pick<VisionBubble, 'speaker' | 'gender' | 'kind'>>> {
  const prompt = `You help read a manga, manhwa or webtoon page aloud with one voice per character. In the image, each text has a red number next to it. For every number, say who speaks it:
${SPEAKER_RULES}
Answer with JSON only: {"items":[{"id":<number>,"speaker":"...","gender":"male|female|unknown","kind":"dialogue|thought|narration|sign"}]}, one entry per number.`;
  const answer = await chat(
    llm,
    [
      { role: 'system', content: prompt },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              (characters ? `Characters so far (reuse these labels):\n${characters}\n` : '') +
              `Texts:\n${texts.map((t) => `${t.id}. ${t.text.replace(/\s+/g, ' ').trim()}`).join('\n')}`,
          },
          { type: 'image_url', image_url: { url: imageDataUrl } },
        ],
      },
    ],
    signal,
  );
  const parsed = parseJsonAnswer<{ items?: unknown[] } | unknown[]>(answer);
  const list = Array.isArray(parsed) ? parsed : (parsed.items ?? []);
  const out = new Map<number, Pick<VisionBubble, 'speaker' | 'gender' | 'kind'>>();
  for (const raw of list) {
    const item = raw as { id?: unknown; speaker?: unknown; gender?: unknown; kind?: unknown };
    const id = Number(item.id);
    if (Number.isFinite(id)) out.set(id, speakerOf(item));
  }
  return out;
}

/** Quick round trip used by the "Test" button in the settings. */
export async function testLlm(llm: LlmSettings): Promise<string> {
  const engine = llmEngine(llm);
  const [out] = await engine.translate({ texts: ['안녕하세요! 만나서 반가워요.'], source: 'ko', target: getSettings().targetLang });
  return out;
}

export interface ProviderLimits {
  /** Requests a day on free models (OpenRouter: 50, or 1000 once 10 credits were bought). */
  daily: number;
  /** Requests a minute on free models. */
  perMinute: number;
  /** The account never bought credits. */
  freeTier: boolean;
}

const LIMITS_KEY = 'webtrad.limits.v1';

/**
 * OpenRouter's limits for this key (GET /key), kept an hour. Undefined for
 * other providers, or when the key cannot be checked.
 */
export async function providerLimits(llm: LlmSettings = getSettings().llm, fresh = false): Promise<ProviderLimits | undefined> {
  if (!/openrouter\.ai/i.test(baseOf(llm)) || !llm.apiKey.trim()) return undefined;
  const id = `${baseOf(llm)}|${llm.apiKey.slice(-6)}`;
  try {
    const cached = JSON.parse(localStorage.getItem(LIMITS_KEY) ?? 'null') as { id: string; at: number; limits: ProviderLimits } | null;
    if (!fresh && cached?.id === id && Date.now() - cached.at < 3_600_000) return cached.limits;
  } catch {
    /* asked again */
  }
  try {
    const data = (await request(llm, 'GET', '/key')) as { data?: { is_free_tier?: boolean } };
    const freeTier = data.data?.is_free_tier !== false;
    const limits = { daily: freeTier ? 50 : 1000, perMinute: 20, freeTier };
    try {
      localStorage.setItem(LIMITS_KEY, JSON.stringify({ id, at: Date.now(), limits }));
    } catch {
      /* asked again next time */
    }
    return limits;
  } catch {
    return undefined;
  }
}
