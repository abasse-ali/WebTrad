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

async function fetchWithProxy(url: string, proxy: string, signal?: AbortSignal, referer?: string): Promise<Response> {
  try {
    const res = await fetch(url, { signal, referrerPolicy: 'no-referrer' });
    if (res.ok) return res;
    if (!proxy) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    if (!proxy.trim()) throw new Error(`CORS / network error for ${url}. Configure a CORS proxy in the settings.`);
  }
  const res = await fetch(proxied(url, proxy, referer), { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} via proxy for ${url}`);
  return res;
}

const SKIP_URL = /(logo|icon|avatar|banner|sprite|emoji|button|thumb|badge|\.svg)(\W|$)/i;

/** Extracts the probable chapter images of an HTML page, in document order. */
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
      if (seen.has(abs) || SKIP_URL.test(abs)) return;
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
  return urls;
}

export interface UrlImportProgress {
  (done: number, total: number): void;
}

/**
 * Each line can be a direct image URL or the URL of a chapter page; in the
 * latter case the images of the page are downloaded (small ones are skipped).
 */
export async function urlsToImages(
  lines: string[],
  proxy: string,
  onProgress?: UrlImportProgress,
  signal?: AbortSignal,
): Promise<ImportedImage[]> {
  const candidates: { url: string; fromPage: boolean; referer?: string }[] = [];
  for (const line of lines.map((l) => l.trim()).filter(Boolean)) {
    if (IMAGE_EXT.test(new URL(line).pathname)) {
      candidates.push({ url: line, fromPage: false });
      continue;
    }
    const res = await fetchWithProxy(line, proxy, signal);
    const type = res.headers.get('content-type') ?? '';
    if (type.startsWith('image/')) {
      candidates.push({ url: line, fromPage: false });
      continue;
    }
    const html = await res.text();
    extractImageUrls(html, line).forEach((url) => candidates.push({ url, fromPage: true, referer: line }));
  }
  const out: (ImportedImage | null)[] = new Array(candidates.length).fill(null);
  let done = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < candidates.length) {
      const i = cursor++;
      const { url, fromPage, referer } = candidates[i];
      try {
        const res = await fetchWithProxy(url, proxy, signal, referer);
        const blob = await res.blob();
        if (!blob.type.startsWith('image/') && !IMAGE_EXT.test(url)) continue;
        if (fromPage) {
          const { width, height } = await imageSize(blob);
          if (width < 300 || height < 300) continue; // icons, ads, avatars
        }
        const name = `${String(i + 1).padStart(3, '0')}-${decodeURIComponent(new URL(url).pathname.split('/').pop() ?? 'image')}`;
        out[i] = { name, blob };
      } catch (err) {
        if ((err as Error).name === 'AbortError') throw err;
        if (!fromPage) throw err;
      } finally {
        done++;
        onProgress?.(done, candidates.length);
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return out.filter((x): x is ImportedImage => x !== null);
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
