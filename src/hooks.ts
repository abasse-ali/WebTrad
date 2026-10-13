import { useEffect, useState } from 'react';
import { getChapter, getPages, listChapters, onDbChange } from './lib/db';
import type { Chapter, Page } from './lib/types';

/** Re-runs `load` whenever the database changes for the given chapter (or any). */
function useDbQuery<T>(load: () => Promise<T>, chapterId: string | null, deps: unknown[]): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    let pending = false;
    const refresh = () => {
      if (pending) return;
      pending = true;
      // Coalesce bursts of writes into one reload.
      setTimeout(() => {
        pending = false;
        load().then((v) => alive && setValue(v));
      }, 30);
    };
    load().then((v) => alive && setValue(v));
    const off = onDbChange((id) => {
      if (chapterId === null || id === null || id === chapterId) refresh();
    });
    return () => {
      alive = false;
      off();
    };
  }, deps);
  return value;
}

export function useChapters(): Chapter[] | undefined {
  return useDbQuery(listChapters, null, []);
}

export function useChapter(id: string): { chapter: Chapter | null | undefined; pages: Page[] | undefined } {
  const chapter = useDbQuery(async () => (await getChapter(id)) ?? null, id, [id]);
  const pages = useDbQuery(() => getPages(id), id, [id]);
  return { chapter, pages };
}

/** Object URL for a blob, revoked automatically. */
export function useObjectUrl(blob: Blob | undefined): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob) return;
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

export function useStorageEstimate(deps: unknown[] = []): { usage: number; quota: number } | null {
  const [estimate, setEstimate] = useState<{ usage: number; quota: number } | null>(null);
  useEffect(() => {
    navigator.storage
      ?.estimate?.()
      .then((e) => setEstimate({ usage: e.usage ?? 0, quota: e.quota ?? 0 }))
      .catch(() => undefined);
  }, deps);
  return estimate;
}
