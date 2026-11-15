import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { englishName } from '../languages';
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

async function request(llm: LlmSettings, method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  let res: RawResponse;
  try {
    res = await call(method, `${baseOf(llm)}${path}`, authHeaders(llm), body, signal);
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    const hint = Capacitor.isNativePlatform()
      ? 'Check the URL and the network.'
      : 'Check the URL. If the provider refuses calls from web pages (CORS, e.g. NVIDIA), use the iPhone app.';
    throw new TranslateError(`AI endpoint unreachable (${(err as Error).message}). ${hint}`, 'llm');
  }
  if (res.status < 200 || res.status >= 300) {
    throw new TranslateError(`AI endpoint HTTP ${res.status} ${res.text.slice(0, 300)}`, 'llm', res.status === 429 || res.status >= 500);
  }
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

/** Models the key gives access to (OpenAI-compatible /models), sorted by name. */
export async function listModels(llm: LlmSettings): Promise<string[]> {
  if (!baseOf(llm)) throw new TranslateError('AI engine not configured', 'llm', false);
  const data = (await request(llm, 'GET', '/models')) as { data?: { id?: string }[] };
  return (data.data ?? [])
    .map((m) => m.id ?? '')
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
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
      if (end > start) return JSON.parse(body.slice(start, end + 1)) as T;
    }
    throw new TranslateError('AI answer is not valid JSON', 'llm');
  }
}

const SYSTEM_TRANSLATE = `You are an expert translator of manga, manhwa, manhua, webtoons and comics.
You receive the text of the speech bubbles of one page, in reading order. The text comes from OCR and may contain recognition errors: infer the intended words.
Translate every bubble naturally, the way a professional scanlation team would: short, spoken, faithful to tone and character voice. Keep names consistent, adapt onomatopoeia and interjections, do not add notes or explanations.
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
Find every piece of story text in the image: speech bubbles, thought bubbles, narration boxes, sound effects, and text written on objects or in the scenery (signs, screens, phones, letters, labels, posters). Ignore watermarks, page numbers and credits.
For each one give its bounding box as ${box} normalised to 0-1000 (tight around the lettering), the exact original text, and a natural translation in the requested language.
Also give the language of the original text as an ISO 639-1 code ("ko", "ja", "zh-Hans", "zh-Hant", "en"…).
Answer with JSON only: {"source_language":"<code>","bubbles":[{"${key}":${box.replace(/ /g, '')},"text":"...","translation":"..."}]} in reading order. Return {"bubbles":[]} if there is no text.`;
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
              source === 'auto'
                ? `Detect the source language. Translate into ${englishName(target)}.`
                : `Source language: ${englishName(source)}. Translate into ${englishName(target)}.`,
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
    const item = raw as { box_2d?: unknown; bbox_2d?: unknown; bbox?: unknown; box?: unknown; text?: unknown; translation?: unknown };
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
