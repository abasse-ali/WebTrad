/**
 * "Paste a link and read": from a chapter address straight to the reader,
 * the translation starting while the first page shows. Used by the link field
 * of the library and by "Next chapter" at the end of a chapter.
 */
import { useSyncExternalStore } from 'react';
import { translate, type MessageKey } from '../i18n';
import { createChapter, guessTitle, ImportError, isImageUrl, urlsToImages, type UrlImportResult } from './importers';
import { importFromBrowser, isNativeApp } from './native';
import { logError, logInfo } from './log';
import { startChapter } from './pipeline';
import { getSettings } from './settings';
import type { Chapter } from './types';
import { warmUpTranslator } from './translate';
import { navigate } from '../router';

export interface QuickState {
  url: string;
  message: string;
  /** Set when it failed: the import screen can take over. */
  error?: string;
}

let state: QuickState | null = null;
const listeners = new Set<() => void>();
let controller: AbortController | null = null;

function set(next: QuickState | null): void {
  state = next;
  listeners.forEach((l) => l());
}

export function useQuickImport(): QuickState | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

export function dismissQuickImport(): void {
  controller?.abort();
  controller = null;
  set(null);
}

const BLOCKED_KEY = 'webtrad.blockedHosts';

function blockedHosts(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(BLOCKED_KEY) ?? '[]') as unknown;
    return Array.isArray(list) ? list.filter((h): h is string => typeof h === 'string') : [];
  } catch {
    return [];
  }
}

/** Websites that turned the relays away once will do it again. */
export function rememberBlocked(url: string): void {
  try {
    const host = new URL(url).hostname;
    const list = blockedHosts().filter((h) => h !== host);
    localStorage.setItem(BLOCKED_KEY, JSON.stringify([host, ...list].slice(0, 50)));
  } catch {
    /* ignore */
  }
}

export function isKnownBlocked(url: string): boolean {
  try {
    return blockedHosts().includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function browserLabels(t: (key: MessageKey) => string): Record<string, string> {
  return {
    grab: t('browser.grab'),
    close: t('common.close'),
    address: t('browser.address'),
    collecting: t('browser.collecting'),
    noImages: t('new.noImages'),
    loading: t('browser.loading'),
    checking: t('browser.checking'),
    showPage: t('browser.showPage'),
    manual: t('browser.manual'),
  };
}

/**
 * Imports the chapter at `url` and opens it in the reader. Must be called
 * from a tap: the browser's translator may need it to download its model.
 */
export interface QuickOptions {
  /** Title typed by the reader (else the one of the page). */
  title?: string;
  targetLang?: string;
  layout?: Chapter['layout'];
}

export async function quickImport(url: string, options: QuickOptions = {}): Promise<void> {
  const settings = getSettings();
  const targetLang = options.targetLang ?? settings.targetLang;
  const t = (key: MessageKey, vars?: Record<string, string | number>) => translate(settings.uiLang, key, vars);
  warmUpTranslator(settings.sourceLang, targetLang);
  controller?.abort();
  const own = new AbortController();
  controller = own;
  const progress = (done: number, total: number) => set({ url, message: t('new.fetching', { done, total }) });
  set({ url, message: t('new.readingPage') });
  logInfo('import', `Lecture rapide demandée : ${url}`);
  try {
    let found: (UrlImportResult & { page?: string }) | null;
    const viaBrowser = () => importFromBrowser(url, browserLabels(t), progress, true);
    if (isNativeApp() && isKnownBlocked(url)) {
      found = await viaBrowser();
    } else {
      try {
        found = await urlsToImages([url], settings.corsProxy, progress, own.signal, () => set({ url, message: t('new.readingPage') }));
      } catch (err) {
        if (!(err instanceof ImportError && err.code === 'PAGE_BLOCKED')) throw err;
        rememberBlocked(url);
        if (!isNativeApp()) throw err;
        // The iPhone app opens the page in its own browser, which the website lets in.
        found = await viaBrowser();
      }
    }
    if (own.signal.aborted) return;
    if (!found) {
      set(null); // closed by the reader
      return;
    }
    if (found.images.length === 0) throw new Error(t('new.noImages'));
    set({ url, message: t('common.loading') });
    const chapter = await createChapter({
      title: options.title?.trim() || found.title || guessTitle(url),
      images: found.images,
      sourceLang: settings.sourceLang,
      targetLang,
      layout: options.layout,
      origin: found.page ?? (isImageUrl(url) ? undefined : url),
      nextUrl: found.nextUrl,
      coverBlob: found.coverBlob,
    });
    void startChapter(chapter.id);
    set(null);
    navigate(`/read/${encodeURIComponent(chapter.id)}`);
  } catch (err) {
    if (own.signal.aborted) return;
    let message: string;
    if (err instanceof ImportError) {
      const host = (() => {
        try {
          return new URL(err.url).hostname.replace(/^www\./, '');
        } catch {
          return err.url;
        }
      })();
      message =
        err.code === 'PAGE_BLOCKED'
          ? t('new.pageBlocked', { host })
          : t(err.code === 'PAGE_UNREACHABLE' ? 'new.pageUnreachable' : 'new.imageUnreachable', { url: err.url });
    } else message = (err as Error).message || String(err);
    logError('import', `Lecture rapide impossible : ${message}`, { url });
    set({ url, message, error: message });
  } finally {
    if (controller === own) controller = null;
  }
}
