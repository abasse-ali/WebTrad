/**
 * Speakers of pages translated before the AI said who speaks: the page is
 * sent again in strips, each text numbered in red next to its bubble, and
 * the AI only says who speaks which number. Done once per page, kept with
 * the page.
 */
import { charactersFor, rememberSpeakers } from './cast';
import { getPage, patchPage } from './db';
import { context2d, createCanvas, decodeImage } from './image';
import { logInfo, logWarn } from './log';
import { visionEnabled } from './pipeline';
import { identifySpeakers } from './translate/llm';
import type { Bubble, Chapter, Page } from './types';

/** Longest side of a strip sent to the AI. */
const MAX_SIDE = 1536;

/** Bubbles read aloud: translated, shown, the end of a cut bubble left out (read with its start). */
export function readable(bubbles: Bubble[], layout?: Chapter['layout']): Bubble[] {
  return bubbles
    .filter((b) => !b.hidden && b.seam !== 'prev' && /[\p{L}\p{N}]/u.test(b.translation))
    .sort((a, b) => {
      // Reading order: top to bottom; side by side (same height), left first
      // (right first in a manga).
      const overlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (overlap > Math.min(a.h, b.h) * 0.5) return layout === 'manga' ? b.x - a.x : a.x - b.x;
      return a.y - b.y;
    });
}

/** Bubbles of the page whose speaker was never asked. */
function unknown(page: Page): Bubble[] {
  return readable(page.bubbles).filter((b) => !b.speaker && !b.kind);
}

export function needsSpeakers(page: Page): boolean {
  return visionEnabled() && unknown(page).length > 0;
}

const pending = new Map<string, Promise<Page>>();

/** The page with the speaker of each text, asked to the AI when missing (once at a time per page). */
export function ensureSpeakers(page: Page, chapter: Chapter, signal?: AbortSignal): Promise<Page> {
  if (!needsSpeakers(page)) return Promise.resolve(page);
  let job = pending.get(page.id);
  if (!job) {
    job = identifyPage(page, chapter, signal).finally(() => pending.delete(page.id));
    pending.set(page.id, job);
  }
  return job;
}

async function identifyPage(page: Page, chapter: Chapter, signal?: AbortSignal): Promise<Page> {
  const todo = unknown(page);
  const W = page.width;
  const H = page.height;
  const stripH = Math.min(H, Math.round(W * 2.2));
  const found = new Map<string, Pick<Bubble, 'speaker' | 'gender' | 'kind'>>();
  const bitmap = await decodeImage(page.blob);
  try {
    // Strips holding the bubbles, each bubble in the strip of its middle.
    let left = [...todo];
    while (left.length > 0) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const first = left[0];
      const top = Math.max(0, Math.min(H - stripH, Math.round(first.y + first.h / 2 - stripH * 0.15)));
      const inStrip = left.filter((b) => b.y + b.h / 2 >= top && b.y + b.h / 2 < top + stripH);
      left = left.filter((b) => !inStrip.includes(b));
      const k = Math.min(1, MAX_SIDE / Math.max(W, stripH));
      const canvas = createCanvas(Math.round(W * k), Math.round(stripH * k));
      const c = context2d(canvas);
      c.drawImage(bitmap.source, 0, top, W, stripH, 0, 0, canvas.width, canvas.height);
      // A red number beside each text (left of it, or right when there is no room).
      const r = Math.max(10, Math.round(canvas.width * 0.025));
      inStrip.forEach((b, i) => {
        const cy = (b.y + b.h / 2 - top) * k;
        let cx = b.x * k - r * 1.4;
        if (cx < r) cx = (b.x + b.w) * k + r * 1.4;
        c.fillStyle = '#e11d48';
        c.beginPath();
        c.arc(cx, cy, r, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = '#ffffff';
        c.font = `bold ${Math.round(r * 1.3)}px sans-serif`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(String(i + 1), cx, cy + 1);
      });
      const image = canvas.toDataURL('image/jpeg', 0.85);
      canvas.width = canvas.height = 0;
      const texts = inStrip.map((b, i) => ({ id: i + 1, text: b.original || b.translation }));
      try {
        const answer = await identifySpeakers(image, texts, charactersFor(chapter.title), signal);
        inStrip.forEach((b, i) => found.set(b.id, answer.get(i + 1) ?? {}));
      } catch (err) {
        if ((err as Error).name === 'AbortError') throw err;
        logWarn('voix', `Personnages de la page ${page.index + 1} non reconnus : ${(err as Error).message.slice(0, 120)}`);
        return page;
      }
    }
  } finally {
    bitmap.close();
  }
  // Saved on the latest copy of the page (the reader may have edited it meanwhile).
  const fresh = (await getPage(page.id)) ?? page;
  const bubbles = fresh.bubbles.map((b) => {
    const f = found.get(b.id);
    if (!f) return b;
    // "dialogue" marks a bubble as asked even when the AI could not tell.
    return { ...b, speaker: f.speaker ?? b.speaker, gender: f.gender ?? b.gender, kind: f.kind ?? 'dialogue' };
  });
  await patchPage(page.id, { bubbles });
  rememberSpeakers(chapter.title, bubbles.filter((b) => found.has(b.id)));
  const names = [...new Set([...found.values()].map((f) => f.speaker).filter(Boolean))];
  logInfo('voix', `Personnages de la page ${page.index + 1} : ${names.join(', ') || 'aucun reconnu'}`);
  return { ...fresh, bubbles };
}
