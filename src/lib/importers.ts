import JSZip from 'jszip';
import { saveChapter, savePages, uid } from './db';
import { imageSize, makeThumbnail } from './image';
import type { Chapter, Page } from './types';

export interface ImportedImage {
  name: string;
  blob: Blob;
}

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;
const ARCHIVE_EXT = /\.(zip|cbz)$/i;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function naturalSort<T extends { name: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => collator.compare(a.name, b.name));
}

function mimeFor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return (
    { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp' }[
      ext
    ] ?? 'application/octet-stream'
  );
}

async function readArchive(file: Blob): Promise<ImportedImage[]> {
  const zip = await JSZip.loadAsync(file);
  const entries = Object.values(zip.files).filter(
    (f) => !f.dir && IMAGE_EXT.test(f.name) && !f.name.startsWith('__MACOSX/') && !/(^|\/)\./.test(f.name),
  );
  const images = await Promise.all(
    entries.map(async (f) => ({ name: f.name, blob: new Blob([await f.async('arraybuffer')], { type: mimeFor(f.name) }) })),
  );
  return naturalSort(images);
}

/** Accepts images, folders and .zip/.cbz archives (in any mix). */
export async function filesToImages(files: File[]): Promise<ImportedImage[]> {
  const out: ImportedImage[] = [];
  const sorted = [...files].sort((a, b) =>
    collator.compare(a.webkitRelativePath || a.name, b.webkitRelativePath || b.name),
  );
  for (const file of sorted) {
    const name = file.webkitRelativePath || file.name;
    if (ARCHIVE_EXT.test(file.name) || file.type === 'application/zip') out.push(...(await readArchive(file)));
    else if (file.type.startsWith('image/') || IMAGE_EXT.test(file.name)) out.push({ name, blob: file });
  }
  return out;
}

// --- URL import -----------------------------------------------------------------

/**
 * Builds the proxied address. The template may contain `{url}` and
 * `{referer}`; without `{url}` the encoded address is appended.
 */
export function proxied(url: string, proxy: string, referer?: string): string {
  const p = proxy.trim();
  if (!p) return url;
  const withReferer = p.replace('{referer}', encodeURIComponent(referer ?? url));
  return withReferer.includes('{url}')
    ? withReferer.replace('{url}', encodeURIComponent(url))
    : withReferer + encodeURIComponent(url);
}

// Free public services used when a website does not allow cross-site reads:
// r.jina.ai renders the page (JavaScript included) and returns its HTML,
// wsrv.nl relays images with the CORS header that lets us read their pixels.
// allorigins / codetabs are last-resort generic relays.
const PAGE_RELAY = 'https://r.jina.ai/';
const IMAGE_RELAY = 'https://wsrv.nl/?url=';
const GENERIC_RELAYS = ['https://api.allorigins.win/raw?url=', 'https://api.codetabs.com/v1/proxy?quest='];

type Kind = 'page' | 'image';

interface Route {
  id: string;
  url: string;
  init?: RequestInit;
  /** Public relays are shared and sometimes refuse a burst: worth one retry. */
  retry?: boolean;
}

export function routesFor(url: string, kind: Kind, proxy: string, referer?: string): Route[] {
  const routes: Route[] = [{ id: 'direct', url, init: { referrerPolicy: 'no-referrer' } }];
  if (proxy.trim()) routes.push({ id: 'proxy', url: proxied(url, proxy, referer) });
  routes.push(
    kind === 'page'
      ? { id: 'jina', url: PAGE_RELAY + url, init: { headers: { 'X-Return-Format': 'html' } }, retry: true }
      : { id: 'wsrv', url: IMAGE_RELAY + encodeURIComponent(url), retry: true },
  );
  GENERIC_RELAYS.forEach((r, i) => routes.push({ id: `relay${i + 1}`, url: r + encodeURIComponent(url) }));
  return routes;
}

/** Remembers which route works for each host so we don't retry dead ends. */
const preferredRoute = new Map<string, string>();

export class ImportError extends Error {
  constructor(
    readonly code: 'PAGE_UNREACHABLE' | 'IMAGE_UNREACHABLE',
    readonly url: string,
    detail: string,
  ) {
    super(`${code}: ${url} (${detail})`);
    this.name = 'ImportError';
  }
}

/** Aborts when the caller cancels or after `ms` (a hung route must not block the import). */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  const any = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  return signal && any ? any([signal, timeout]) : (signal ?? timeout);
}

const DIRECT_TIMEOUT = 15_000;
const RELAY_TIMEOUT = 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchAny(url: string, kind: Kind, proxy: string, signal?: AbortSignal, referer?: string): Promise<{ res: Response; route: string }> {
  const host = `${kind}:${new URL(url).host}`;
  const routes = routesFor(url, kind, proxy, referer);
  const preferred = preferredRoute.get(host);
  if (preferred) routes.sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred));
  const errors: string[] = [];
  for (const route of routes) {
    for (let attempt = 0; attempt < (route.retry ? 2 : 1); attempt++) {
      if (attempt > 0) await sleep(1500);
      try {
        const timeout = route.id === 'direct' ? DIRECT_TIMEOUT : RELAY_TIMEOUT;
        const res = await fetch(route.url, { ...route.init, signal: withTimeout(signal, timeout) });
        const type = res.headers.get('content-type') ?? '';
        if (!res.ok) {
          errors.push(`${route.id}: HTTP ${res.status}`);
          // Only rate limits and server hiccups are worth a second try.
          if (res.status === 401 || res.status === 429 || res.status >= 500) continue;
          break;
        }
        if (kind === 'image' && !type.startsWith('image/') && !type.startsWith('application/octet-stream')) {
          errors.push(`${route.id}: ${type || 'not an image'}`);
          break;
        }
        preferredRoute.set(host, route.id);
        return { res, route: route.id };
      } catch (err) {
        if (signal?.aborted) throw err;
        errors.push(`${route.id}: ${(err as Error).message}`);
      }
    }
  }
  throw new ImportError(kind === 'page' ? 'PAGE_UNREACHABLE' : 'IMAGE_UNREACHABLE', url, errors.join(' · '));
}

const SKIP_URL = /(logo|icon|avatar|banner|sprite|emoji|button|thumb|badge|\.svg)(\W|$)/i;

function directoryOf(url: string): string {
  const u = new URL(url);
  return u.origin + u.pathname.slice(0, u.pathname.lastIndexOf('/') + 1);
}

/**
 * Extracts the probable chapter images of an HTML page, in document order.
 * Chapter pages almost always live in one folder: when a folder holds at
 * least 3 images, logos and ads stored elsewhere are dropped.
 */
export function extractImageUrls(html: string, pageUrl: string): string[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const urls: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string | null | undefined) => {
    if (!raw) return;
    const value = raw.trim();
    if (!value || value.startsWith('data:')) return;
    try {
      const abs = new URL(value, pageUrl).href;
      if (seen.has(abs) || SKIP_URL.test(abs) || !/^https?:/.test(abs)) return;
      seen.add(abs);
      urls.push(abs);
    } catch {
      /* invalid URL */
    }
  };
  doc.querySelectorAll('img').forEach((img) => {
    const lazy =
      img.getAttribute('data-src') ??
      img.getAttribute('data-original') ??
      img.getAttribute('data-lazy-src') ??
      img.getAttribute('data-url') ??
      img.getAttribute('data-srcset')?.split(',').pop()?.trim().split(/\s+/)[0];
    const srcset = img.getAttribute('srcset')?.split(',').pop()?.trim().split(/\s+/)[0];
    add(lazy ?? srcset ?? img.getAttribute('src'));
  });
  const counts = new Map<string, number>();
  for (const u of urls) counts.set(directoryOf(u), (counts.get(directoryOf(u)) ?? 0) + 1);
  const [mainDir, mainCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
  return mainCount >= 3 ? urls.filter((u) => directoryOf(u) === mainDir) : urls;
}

/** "Series - Chapter 12 - Site name - Read online" → "Series - Chapter 12". */
export function titleFromHtml(html: string): string {
  const raw = new DOMParser().parseFromString(html, 'text/html').title.trim();
  if (!raw) return '';
  const parts = raw.split(/\s+[-|–—:]\s+/).filter(Boolean);
  const chapterIdx = parts.findIndex((p) => /(chap|ch\.|episode|ép|ep\.?\s*\d|第|화|話|回)/i.test(p));
  const kept = chapterIdx >= 0 ? parts.slice(0, chapterIdx + 1) : parts.slice(0, Math.min(2, parts.length));
  return kept.join(' - ').slice(0, 80);
}

export interface UrlImportProgress {
  (done: number, total: number): void;
}

export interface UrlImportResult {
  images: ImportedImage[];
  title: string;
}

/**
 * Each line can be a direct image URL or the URL of a chapter page; in the
 * latter case the images of the page are downloaded (small ones are skipped).
 * Websites that block cross-site reads are fetched through free relays.
 */
export async function urlsToImages(
  lines: string[],
  proxy: string,
  onProgress?: UrlImportProgress,
  signal?: AbortSignal,
  onPage?: (url: string) => void,
): Promise<UrlImportResult> {
  const candidates: { url: string; fromPage: boolean; referer?: string }[] = [];
  let title = '';
  for (const line of lines.map((l) => l.trim()).filter(Boolean)) {
    if (IMAGE_EXT.test(new URL(line).pathname)) {
      candidates.push({ url: line, fromPage: false });
      continue;
    }
    onPage?.(line);
    let { res, route } = await fetchAny(line, 'page', proxy, signal);
    if ((res.headers.get('content-type') ?? '').startsWith('image/')) {
      candidates.push({ url: line, fromPage: false });
      continue;
    }
    let html = await res.text();
    let found = extractImageUrls(html, line);
    // Images inserted by JavaScript: ask the relay for the rendered page.
    if (found.length === 0 && route !== 'jina') {
      res = await fetch(PAGE_RELAY + line, {
        headers: { 'X-Return-Format': 'html' },
        signal: withTimeout(signal, RELAY_TIMEOUT),
      });
      if (res.ok) {
        html = await res.text();
        found = extractImageUrls(html, line);
        route = 'jina';
      }
    }
    title ||= titleFromHtml(html);
    found.forEach((url) => candidates.push({ url, fromPage: true, referer: line }));
  }
  const out: (ImportedImage | null)[] = new Array(candidates.length).fill(null);
  let done = 0;
  let cursor = 0;
  let lastError: unknown = null;
  const worker = async () => {
    while (cursor < candidates.length) {
      const i = cursor++;
      const { url, fromPage, referer } = candidates[i];
      try {
        const { res } = await fetchAny(url, 'image', proxy, signal, referer);
        const blob = await res.blob();
        if (fromPage) {
          const { width, height } = await imageSize(blob);
          if (width < 300 || height < 300) continue; // icons, ads, avatars
        }
        const name = `${String(i + 1).padStart(3, '0')}-${decodeURIComponent(new URL(url).pathname.split('/').pop() ?? 'image')}`;
        out[i] = { name, blob };
      } catch (err) {
        if ((err as Error).name === 'AbortError') throw err;
        lastError = err;
        if (!fromPage) throw err;
      } finally {
        done++;
        onProgress?.(done, candidates.length);
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  const images = out.filter((x): x is ImportedImage => x !== null);
  if (images.length === 0 && lastError) throw lastError;
  return { images, title };
}

// --- chapter creation -----------------------------------------------------------

export async function createChapter(input: {
  title: string;
  images: ImportedImage[];
  sourceLang: string;
  targetLang: string;
  origin?: string;
}): Promise<Chapter> {
  const chapterId = uid();
  const pages: Page[] = [];
  for (const [index, image] of input.images.entries()) {
    let size: { width: number; height: number };
    try {
      size = await imageSize(image.blob);
    } catch {
      continue; // undecodable file (HEIC, corrupted…)
    }
    pages.push({
      id: uid(),
      chapterId,
      index,
      name: image.name,
      width: size.width,
      height: size.height,
      blob: image.blob,
      status: 'pending',
      bubbles: [],
    });
  }
  if (pages.length === 0) throw new Error('NO_IMAGES');
  pages.forEach((p, i) => (p.index = i));
  const now = Date.now();
  const chapter: Chapter = {
    id: chapterId,
    title: input.title.trim() || 'Chapitre',
    createdAt: now,
    updatedAt: now,
    sourceLang: input.sourceLang,
    targetLang: input.targetLang,
    pageIds: pages.map((p) => p.id),
    cover: await makeThumbnail(pages[0].blob).catch(() => undefined),
    origin: input.origin,
  };
  await savePages(pages);
  await saveChapter(chapter);
  return chapter;
}

/** Guesses a chapter title from file names or a URL. */
export function guessTitle(source: string): string {
  if (/^https?:\/\//i.test(source)) {
    try {
      const url = new URL(source);
      const parts = url.pathname
        .split('/')
        .filter(Boolean)
        .map((p) => p.replace(/\.(html?|php|aspx?)$/i, ''));
      const name = parts.slice(-2).join(' ') || url.hostname;
      return decodeURIComponent(name).replace(/[_+-]+/g, ' ').trim().slice(0, 80);
    } catch {
      return source.slice(0, 80);
    }
  }
  const base = source.split(/[\\/]/).filter(Boolean).at(-2) ?? source;
  return decodeURIComponent(base)
    .replace(/\.(zip|cbz|jpe?g|png|webp)$/i, '')
    .replace(/[_+-]+/g, ' ')
    .trim()
    .slice(0, 80);
}
