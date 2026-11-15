/**
 * Bridge to the iPhone app (Capacitor). In the web version none of this runs:
 * `isNativeApp()` is false and the plugins are never called.
 */
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { imageSize } from './image';
import { logInfo } from './log';
import { cleanTitle, pickChapterImages, usableCover, type ImportedImage, type UrlImportResult } from './importers';

interface BrowserPage {
  cancelled?: boolean;
  images?: string[];
  title?: string;
  page?: string;
  next?: string;
  /** Series artwork named by the page (og:image). */
  cover?: string;
}

interface WebTradBrowserPlugin {
  open(options: { url?: string; labels: Record<string, string>; auto?: boolean }): Promise<BrowserPage>;
  download(options: { urls: string[]; referer?: string }): Promise<{ files: { url: string; path: string }[]; failed: number }>;
  readClipboard(): Promise<{ text: string }>;
  addListener(event: 'progress', listener: (e: { done: number; total: number }) => void): Promise<PluginListenerHandle>;
}

const WebTradBrowser = registerPlugin<WebTradBrowserPlugin>('WebTradBrowser');

export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform();
}

export interface BrowserImport extends UrlImportResult {
  /** Address of the chapter page the images come from. */
  page?: string;
}

/**
 * Opens the in-app browser; when the reader taps "Get pages", the images of
 * the page are downloaded with the browser's session. Null when closed.
 */
export async function importFromBrowser(
  url: string | undefined,
  labels: Record<string, string>,
  onProgress?: (done: number, total: number) => void,
  auto = false,
): Promise<BrowserImport | null> {
  const found = await WebTradBrowser.open({ url, labels, auto });
  if (found.cancelled || !found.images?.length) {
    logInfo('import', 'Navigateur intégré fermé sans récupérer de pages', { url });
    return null;
  }
  logInfo('import', `Navigateur intégré : ${found.images.length} image(s) sur la page`, { page: found.page, auto });
  const urls = pickChapterImages(found.images);
  // The series artwork comes with the pages, with the same session (Cloudflare…).
  const cover = found.cover && !urls.includes(found.cover) ? found.cover : undefined;
  onProgress?.(0, urls.length);
  const listener = await WebTradBrowser.addListener('progress', (e) => onProgress?.(e.done, e.total));
  let files: { url: string; path: string }[];
  try {
    ({ files } = await WebTradBrowser.download({ urls: cover ? [...urls, cover] : urls, referer: found.page }));
  } finally {
    await listener.remove();
  }
  const images: ImportedImage[] = [];
  let coverBlob: Blob | undefined;
  for (const [i, file] of files.entries()) {
    try {
      if (cover && file.url === cover) {
        const blob = await (await fetch(Capacitor.convertFileSrc(file.path))).blob();
        if (await usableCover(blob)) coverBlob = blob;
        continue;
      }
      const blob = await (await fetch(Capacitor.convertFileSrc(file.path))).blob();
      const { width, height } = await imageSize(blob);
      if (width < 300 || height < 300) continue; // icons, ads, avatars
      const name = decodeURIComponent(new URL(file.url).pathname.split('/').pop() || 'image');
      images.push({ name: `${String(i + 1).padStart(3, '0')}-${name}`, blob });
    } catch {
      /* unreadable image: skipped */
    }
  }
  return { images, title: cleanTitle(found.title ?? ''), nextUrl: found.next || undefined, page: found.page, coverBlob };
}

/** iPhone app: files are handed to the share sheet (save to Files, send…). */
export async function shareFile(blob: Blob, filename: string): Promise<void> {
  const [{ Filesystem, Directory }, { Share }] = await Promise.all([import('@capacitor/filesystem'), import('@capacitor/share')]);
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  const { uri } = await Filesystem.writeFile({ path: filename, data, directory: Directory.Cache });
  await Share.share({ title: filename, files: [uri] });
}

/** iPhone app: several images handed to the share sheet at once ("Save N images"). */
export async function shareFiles(files: { blob: Blob; name: string }[]): Promise<void> {
  const [{ Filesystem, Directory }, { Share }] = await Promise.all([import('@capacitor/filesystem'), import('@capacitor/share')]);
  const uris: string[] = [];
  for (const file of files) {
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file.blob);
    });
    const { uri } = await Filesystem.writeFile({ path: `export/${file.name}`, data, directory: Directory.Cache, recursive: true });
    uris.push(uri);
  }
  await Share.share({ files: uris });
}

/**
 * iPhone app: opens a chapter page in the in-app browser (behind its
 * progress card) only to get the series artwork it names.
 */
export async function coverWithBrowser(url: string, labels: Record<string, string>): Promise<Blob | undefined> {
  const found = await WebTradBrowser.open({ url, labels, auto: true });
  if (found.cancelled || !found.cover) return undefined;
  const { files } = await WebTradBrowser.download({ urls: [found.cover], referer: found.page });
  if (files.length === 0) return undefined;
  const blob = await (await fetch(Capacitor.convertFileSrc(files[0].path))).blob();
  return (await usableCover(blob)) ? blob : undefined;
}

/**
 * Text of the clipboard. In the iPhone app it is read natively: no "Paste"
 * bubble at each tap (iOS asks once, and can be told to always allow).
 */
export async function readClipboard(): Promise<string> {
  if (isNativeApp()) {
    try {
      return (await WebTradBrowser.readClipboard()).text;
    } catch {
      /* older app build: the web way below */
    }
  }
  return navigator.clipboard.readText();
}
