import { useEffect, useRef, useState, type RefObject } from 'react';
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

// One observer for every page of the reader: a long chapter has dozens of them.
const nearCallbacks = new WeakMap<Element, (near: boolean) => void>();
let nearObserver: IntersectionObserver | null = null;

function observeNear(el: Element, cb: (near: boolean) => void): () => void {
  nearObserver ??= new IntersectionObserver(
    (entries) => entries.forEach((e) => nearCallbacks.get(e.target)?.(e.isIntersecting)),
    // Two screens above and below: content is ready before it scrolls into view.
    { rootMargin: '200% 0px' },
  );
  nearCallbacks.set(el, cb);
  nearObserver.observe(el);
  return () => {
    nearCallbacks.delete(el);
    nearObserver?.unobserve(el);
  };
}

/**
 * True while the element is on screen or close to it. Webtoon pages are huge
 * images: only the ones around the reader are decoded and lettered.
 */
export function useNearViewport<T extends Element>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    return observeNear(el, setNear);
  }, []);
  return [ref, near];
}

/** Calls `onDismiss` on Escape or on a press outside the element, while `active`. */
export function useDismiss<T extends Element>(active: boolean, onDismiss: () => void): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const latest = useRef(onDismiss);
  latest.current = onDismiss;
  useEffect(() => {
    if (!active) return;
    const onPointer = (e: PointerEvent) => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) latest.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') latest.current();
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [active]);
  return ref;
}
