import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Chapter, Page } from './types';

interface WebTradDB extends DBSchema {
  chapters: { key: string; value: Chapter; indexes: { updatedAt: number } };
  pages: { key: string; value: Page; indexes: { chapterId: string } };
}

let dbPromise: Promise<IDBPDatabase<WebTradDB>> | null = null;

function db(): Promise<IDBPDatabase<WebTradDB>> {
  dbPromise ??= openDB<WebTradDB>('webtrad', 1, {
    upgrade(database) {
      const chapters = database.createObjectStore('chapters', { keyPath: 'id' });
      chapters.createIndex('updatedAt', 'updatedAt');
      const pages = database.createObjectStore('pages', { keyPath: 'id' });
      pages.createIndex('chapterId', 'chapterId');
    },
  });
  return dbPromise;
}

// --- change notifications so every view stays in sync -------------------

type Listener = (chapterId: string | null) => void;
const listeners = new Set<Listener>();

export function onDbChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(chapterId: string | null): void {
  listeners.forEach((l) => l(chapterId));
}

// --- chapters -------------------------------------------------------------

export async function listChapters(): Promise<Chapter[]> {
  const all = await (await db()).getAll('chapters');
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getChapter(id: string): Promise<Chapter | undefined> {
  return (await db()).get('chapters', id);
}

export async function saveChapter(chapter: Chapter): Promise<void> {
  await (await db()).put('chapters', chapter);
  emit(chapter.id);
}

export async function patchChapter(id: string, patch: Partial<Chapter>, touch = true): Promise<void> {
  const database = await db();
  const tx = database.transaction('chapters', 'readwrite');
  const chapter = await tx.store.get(id);
  if (chapter) {
    await tx.store.put({ ...chapter, ...patch, ...(touch ? { updatedAt: Date.now() } : {}) });
  }
  await tx.done;
  emit(id);
}

export async function deleteChapter(id: string): Promise<void> {
  const database = await db();
  const tx = database.transaction(['chapters', 'pages'], 'readwrite');
  const pageKeys = await tx.objectStore('pages').index('chapterId').getAllKeys(id);
  await Promise.all(pageKeys.map((k) => tx.objectStore('pages').delete(k)));
  await tx.objectStore('chapters').delete(id);
  await tx.done;
  emit(id);
}

// --- pages ----------------------------------------------------------------

export async function getPages(chapterId: string): Promise<Page[]> {
  const pages = await (await db()).getAllFromIndex('pages', 'chapterId', chapterId);
  return pages.sort((a, b) => a.index - b.index);
}

export async function getPage(id: string): Promise<Page | undefined> {
  return (await db()).get('pages', id);
}

export async function savePages(pages: Page[]): Promise<void> {
  const database = await db();
  const tx = database.transaction('pages', 'readwrite');
  await Promise.all(pages.map((p) => tx.store.put(p)));
  await tx.done;
  const chapterIds = new Set(pages.map((p) => p.chapterId));
  chapterIds.forEach((id) => emit(id));
}

export async function patchPage(id: string, patch: Partial<Page>): Promise<Page | undefined> {
  const database = await db();
  const tx = database.transaction('pages', 'readwrite');
  const page = await tx.store.get(id);
  let next: Page | undefined;
  if (page) {
    next = { ...page, ...patch, rev: (page.rev ?? 0) + 1 };
    await tx.store.put(next);
  }
  await tx.done;
  if (next) emit(next.chapterId);
  return next;
}

/** Error code of a page that was being processed when the app died, twice. */
export const INTERRUPTED = 'INTERRUPTED';

/**
 * Pages left in "ocr" / "translating" belong to a job that died with its
 * tab (reload, phone locked, browser killed in the background): nothing is
 * working on them any more. Puts them back in the queue and returns the
 * chapters that were interrupted.
 *
 * A page that was in flight at two deaths in a row is probably what kills
 * the tab (image too heavy for the device): it is set aside as an error so
 * resuming the chapter cannot loop on it.
 */
export async function resetStalePages(): Promise<string[]> {
  const database = await db();
  const tx = database.transaction('pages', 'readwrite');
  const interrupted = new Set<string>();
  for (let cursor = await tx.store.openCursor(); cursor; cursor = await cursor.continue()) {
    const page = cursor.value;
    if (page.status !== 'ocr' && page.status !== 'translating') continue;
    const stalled = (page.stalled ?? 0) + 1;
    const next: Page =
      stalled >= 2
        ? { ...page, status: 'error', error: INTERRUPTED, stalled: 0, rev: (page.rev ?? 0) + 1 }
        : { ...page, status: 'pending', stalled, rev: (page.rev ?? 0) + 1 };
    await cursor.update(next);
    interrupted.add(page.chapterId);
  }
  await tx.done;
  interrupted.forEach((id) => emit(id));
  return [...interrupted];
}

export async function clearAll(): Promise<void> {
  const database = await db();
  const tx = database.transaction(['chapters', 'pages'], 'readwrite');
  await tx.objectStore('chapters').clear();
  await tx.objectStore('pages').clear();
  await tx.done;
  emit(null);
}

export function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
