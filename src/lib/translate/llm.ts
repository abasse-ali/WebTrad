import { englishName } from '../languages';
import { getSettings } from '../settings';
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

export async function chat(llm: LlmSettings, messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
  const base = llm.baseUrl.trim().replace(/\/+$/, '');
  if (!base || !llm.model.trim()) throw new TranslateError('AI engine not configured', 'llm', false);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (llm.apiKey.trim()) headers.Authorization = `Bearer ${llm.apiKey.trim()}`;
  let res: Response;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({ model: llm.model.trim(), temperature: 0.2, messages }),
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new TranslateError(`AI endpoint unreachable (${(err as Error).message}). Check the URL and CORS.`, 'llm');
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    throw new TranslateError(`AI endpoint HTTP ${res.status} ${detail}`, 'llm', res.status === 429 || res.status >= 500);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string | { text?: string }[] } }[] };
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

const SYSTEM_VISION = `You are an expert manga, manhwa, manhua, webtoon and comics translator with perfect OCR skills.
Find every piece of story text in the image: speech bubbles, thought bubbles, narration boxes and important sound effects. Ignore watermarks, page numbers and credits.
For each one give its bounding box as [ymin, xmin, ymax, xmax] normalised to 0-1000 (tight around the lettering), the exact original text, and a natural translation in the requested language.
Answer with JSON only: {"bubbles":[{"box_2d":[ymin,xmin,ymax,xmax],"text":"...","translation":"..."}]} in reading order. Return {"bubbles":[]} if there is no text.`;

export async function visionTranslate(
  imageDataUrl: string,
  source: string,
  target: string,
  signal?: AbortSignal,
  llm: LlmSettings = getSettings().llm,
): Promise<VisionBubble[]> {
  const answer = await chat(
    llm,
    [
      { role: 'system', content: SYSTEM_VISION },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Source language: ${englishName(source)}. Translate into ${englishName(target)}.`,
          },
          { type: 'image_url', image_url: { url: imageDataUrl } },
        ],
      },
    ],
    signal,
  );
  const parsed = parseJsonAnswer<{ bubbles?: unknown[] } | unknown[]>(answer);
  const list = Array.isArray(parsed) ? parsed : (parsed.bubbles ?? []);
  const out: VisionBubble[] = [];
  for (const raw of list) {
    const item = raw as { box_2d?: unknown; box?: unknown; text?: unknown; translation?: unknown };
    const box = (item.box_2d ?? item.box) as unknown;
    if (!Array.isArray(box) || box.length !== 4 || !box.every((v) => typeof v === 'number')) continue;
    const [y0, x0, y1, x1] = box as number[];
    if (y1 <= y0 || x1 <= x0) continue;
    out.push({
      box: [y0, x0, y1, x1],
      text: typeof item.text === 'string' ? item.text : '',
      translation: typeof item.translation === 'string' ? item.translation : '',
    });
  }
  return out;
}

/** Quick round trip used by the "Test" button in the settings. */
export async function testLlm(llm: LlmSettings): Promise<string> {
  const engine = llmEngine(llm);
  const [out] = await engine.translate({ texts: ['안녕하세요! 만나서 반가워요.'], source: 'ko', target: getSettings().targetLang });
  return out;
}
