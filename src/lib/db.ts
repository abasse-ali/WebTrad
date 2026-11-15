import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Chapter, Page } from './types';

/**
 * A page as stored. Its image is kept as raw bytes, not as a Blob: on iPhone
 * the blobs of the database are files that WebKit loses when the app is
 * suspended ("Loading error.", "The object can not be found here."), while
 * bytes stored inline always read back. Pages saved by older versions still
 * hold a `blob`; they are converted the first time they are read.
 */
type StoredPage = Omit<Page, 'blob'> & { blob?: Blob; bytes?: ArrayBuffer; type?: string };

interface WebTradDB extends DBSchema {
  chapters: { key: string; value: Chapter; indexes: { updatedAt: number } };
  pages: { key: string; value: StoredPage; indexes: { chapterId: string } };
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

async function toStored(page: Page): Promise<StoredPage> {
  const { blob, ...rest } = page;
  return { ...rest, bytes: await blob.arrayBuffer(), type: blob.type || 'image/jpeg' };
}

/** The page with its image as a fresh in-memory blob (never a file that can vanish). */
async function fromStored(record: StoredPage): Promise<Page> {
  const { bytes, type, blob, ...rest } = record;
  if (bytes) return { ...rest, blob: new Blob([bytes], { type: type || 'image/jpeg' }) };
  // Saved by an older version: converted once, while its file still reads.
  try {
    const data = await blob!.arrayBuffer();
    const kind = blob!.type || 'image/jpeg';
    void (async () => {
      try {
        const database = await db();
        const tx = database.transaction('pages', 'readwrite');
        const current = await tx.store.get(record.id);
        if (current && !current.bytes) await tx.store.put({ ...current, blob: undefined, bytes: data, type: kind });
        await tx.done;
      } catch {
        /* converted next time */
      }
    })();
    return { ...rest, blob: new Blob([data], { type: kind }) };
  } catch {
    return { ...rest, blob: blob! };
  }
}

export async function getPages(chapterId: string): Promise<Page[]> {
  const records = await (await db()).getAllFromIndex('pages', 'chapterId', chapterId);
  const pages = await Promise.all(records.map(fromStored));
  return pages.sort((a, b) => a.index - b.index);
}

export async function getPage(id: string): Promise<Page | undefined> {
  const record = await (await db()).get('pages', id);
  return record ? fromStored(record) : undefined;
}

export async function savePages(pages: Page[]): Promise<void> {
  const records = await Promise.all(pages.map(toStored));
  const database = await db();
  const tx = database.transaction('pages', 'readwrite');
  await Promise.all(records.map((p) => tx.store.put(p)));
  await tx.done;
  const chapterIds = new Set(pages.map((p) => p.chapterId));
  chapterIds.forEach((id) => emit(id));
}

export async function patchPage(id: string, patch: Partial<Page>): Promise<Page | undefined> {
  const { blob: newBlob, ...rest } = patch;
  const image = newBlob ? { blob: undefined, bytes: await newBlob.arrayBuffer(), type: newBlob.type || 'image/jpeg' } : {};
  const database = await db();
  let next: StoredPage | undefined;
  try {
    const tx = database.transaction('pages', 'readwrite');
    const page = await tx.store.get(id);
    if (page) {
      next = { ...page, ...rest, ...image, rev: (page.rev ?? 0) + 1 };
      await tx.store.put(next);
    }
    await tx.done;
  } catch (err) {
    // An old record whose blob WebKit cannot store again ("Error preparing
    // Blob/File data to be stored in object store"): written with its bytes.
    const page = await database.get('pages', id);
    if (!page) throw err;
    const bytes = page.bytes ?? (await page.blob!.arrayBuffer());
    next = { ...page, ...rest, blob: undefined, bytes, type: page.type ?? page.blob?.type ?? 'image/jpeg', ...image, rev: (page.rev ?? 0) + 1 };
    await database.put('pages', next);
  }
  if (!next) return undefined;
  emit(next.chapterId);
  return fromStored(next);
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
    const next: StoredPage =
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
