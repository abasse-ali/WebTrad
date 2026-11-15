import { countRequest } from '../usage';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { englishName } from '../languages';
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
      connectTimeout: 20_000,
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
  return 20_000;
}

function limitOf(body: string): string | undefined {
  return body.match(/"X-RateLimit-Limit"\s*:\s*"?(\d+)/i)?.[1];
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
  // A rate limit was hit: every request waits for the provider's window to reset.
  await waitForCooldown(host, signal);
  // Timed after the pause: the log shows how long the provider took.
  const start = performance.now();
  const images = JSON.stringify((body as { messages?: unknown } | undefined)?.messages ?? '').split('"type":"image_url"').length - 1;
  try {
    res = await call(method, `${baseOf(llm)}${path}`, authHeaders(llm), body, signal);
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
  if (res.status === 429) {
    const waitMs = rateLimitWait(res.text);
    cooldowns.set(host, Math.max(cooldowns.get(host) ?? 0, Date.now() + waitMs));
    logWarn('ia', `Limite de requêtes atteinte (${limitOf(res.text) ?? '?'} par minute) : pause de ${Math.round(waitMs / 1000)} s`, meta);
    throw new TranslateError(`AI endpoint HTTP 429 (rate limit) ${res.text.slice(0, 200)}`, 'llm', true);
  }
  if (res.status < 200 || res.status >= 300) {
    logError('ia', `${method} ${path} → HTTP ${res.status} : ${res.text.slice(0, 160)}`, meta);
    throw new TranslateError(`AI endpoint HTTP ${res.status} ${res.text.slice(0, 300)}`, 'llm', res.status === 429 || res.status >= 500);
  }
  logInfo('ia', `${method} ${path} OK`, meta);
  if (/^\s*(data:|event:|:)/.test(res.text)) return parseStream(res.text);
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
export function parseStream(text: string): { choices: { message: { content: string } }[] } {
  let content = '';
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^data:\s*(.*)$/);
    if (!m || m[1] === '[DONE]' || !m[1].trim()) continue;
    let event: { error?: { message?: string } | string; choices?: { delta?: { content?: unknown }; message?: { content?: unknown } }[] };
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
  }
  return { choices: [{ message: { content } }] };
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
      architecture?: { input_modalities?: string[]; modality?: string };
      pricing?: { prompt?: string | number; completion?: string | number };
    }[];
  };
  return (data.data ?? [])
    .filter((m) => m.id && !NOT_CHAT.test(m.id))
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

export async function chat(llm: LlmSettings, messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
  if (!baseOf(llm) || !llm.model.trim()) throw new TranslateError('AI engine not configured', 'llm', false);
  const data = (await request(
    llm,
    'POST',
    '/chat/completions',
    // Streamed: data keeps flowing while a big model writes a long answer,
    // instead of one silent wait that ends in a timeout.
    { model: llm.model.trim(), temperature: 0.2, messages, stream: true },
    signal,
  )) as { choices?: { message?: { content?: string | { text?: string }[] } }[] };
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
    // Cut or damaged answers (free models stop mid-way): keep the complete items.
    const items = salvageItems(body);
    if (items.length > 0) return { bubbles: items } as T;
    throw new TranslateError('AI answer is not valid JSON', 'llm');
  }
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
      if (!/"translation"\s*:/.test(chunk)) continue;
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

// --- AI vision: read + translate a page image in a single request -----------

export interface VisionBubble {
  /** Normalised 0–1000 box: [ymin, xmin, ymax, xmax]. */
  box: [number, number, number, number];
  text: string;
  translation: string;
}

function visionPrompt(order: 'yxyx' | 'xyxy'): string {
  const box = order === 'xyxy' ? '[xmin, ymin, xmax, ymax]' : '[ymin, xmin, ymax, xmax]';
  const key = order === 'xyxy' ? 'bbox_2d' : 'box_2d';
  return `You are an expert manga, manhwa, manhua, webtoon and comics translator with perfect OCR skills.
Find every piece of story text in the image: speech bubbles, thought bubbles, narration boxes, and text written on objects or in the scenery (signs, screens, phones, letters, labels, posters). Ignore watermarks, page numbers, credits, the series logo or title artwork, and "to be continued" banners.
Do NOT include sound effects or onomatopoeia: drawn effect words such as HUFF, SLAP, SMACK, TWITCH, SWOOSH, GRIP, THRUST, 쿵, 두근, ドキ, ゴゴゴ, 砰 must be left out entirely, even when they are big or in bubbles of their own.
For each one give its bounding box as ${box} normalised to 0-1000 (tight around the lettering), the exact original text, and a translation in the requested language.
How to translate, like a professional scanlation team:
- Read the whole image first: a sentence often runs over several bubbles; translate each bubble so that, read in order, they form natural sentences.
- Translate the meaning, not word for word. Use the words a native speaker would really say in that situation, short enough to fit the bubble.
- Keep each character's voice and register: rude stays rude (swear words stay swear words), polite stays polite, childish stays childish. Keep the same form of address (tu/vous, tutoiement…) between the same characters.
- Keep names, nicknames and usernames as they are; keep the gaming, internet and fandom words that readers of the target language use as they are (teamfight, carry, rank names…), translate the others.
- Interjections in bubbles (Ugh, Huh?, Haha, Hmm, Tch) become their usual equivalents in the target language; stuttering (I-I…) and trailing dots (…) are kept.
- Use the typography of the target language (French: « » for quotes, a space before ? ! : ;).
- Only text in the target language: no notes, no romanisation, no alternatives.
Also give the language of the original text as an ISO 639-1 code ("ko", "ja", "zh-Hans", "zh-Hant", "en"…).
Answer with JSON only: {"source_language":"<code>","bubbles":[{"${key}":${box.replace(/ /g, '')},"kind":"dialogue|narration|sign","text":"...","translation":"..."}]} in reading order. List each piece of text once: never split one bubble into several items. Return {"bubbles":[]} if there is no text.`;
}

/** Box order the configured provider is best at. */
function boxOrderOf(llm: LlmSettings): 'yxyx' | 'xyxy' {
  return LLM_PRESETS.find((p) => p.id === llm.preset)?.boxOrder ?? 'yxyx';
}

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
              (context
                ? `\nStory so far (the last bubbles before this image, original → translation). Use it for the context, names, form of address and tone; do not include these lines in your answer:\n${context}`
                : ''),
          },
          { type: 'image_url', image_url: { url: imageDataUrl } },
        ],
      },
    ],
    signal,
  );
  const parsed = parseJsonAnswer<{ bubbles?: unknown[]; source_language?: string } | unknown[]>(answer);
  const list = Array.isArray(parsed) ? parsed : (parsed.bubbles ?? []);
  const sourceLanguage = Array.isArray(parsed) ? undefined : parsed.source_language;
  const out: VisionBubble[] = [];
  const boxes: { box: number[]; xyxy: boolean; item: { text?: unknown; translation?: unknown } }[] = [];
  for (const raw of list) {
    const item = raw as { box_2d?: unknown; bbox_2d?: unknown; bbox?: unknown; box?: unknown; text?: unknown; translation?: unknown; kind?: unknown; type?: unknown };
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
    out.push({
      box: [y0, x0, y1, x1],
      text: typeof item.text === 'string' ? item.text : '',
      translation: typeof item.translation === 'string' ? item.translation : '',
    });
  }
  return { bubbles: out, sourceLanguage };
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
