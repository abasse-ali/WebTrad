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
