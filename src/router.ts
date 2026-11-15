import { useSyncExternalStore } from 'react';
import type { PageHandoff } from './lib/importers';

export type Route =
  | { name: 'library' }
  | { name: 'new'; url?: string; handoff?: PageHandoff; key: string }
  | { name: 'settings' }
  | { name: 'log' }
  | { name: 'reader'; id: string }
  | { name: 'series'; key: string };

export function parseRoute(hash: string): Route {
  const full = hash.replace(/^#\/?/, '');
  const mark = full.indexOf('?');
  const path = mark >= 0 ? full.slice(0, mark) : full;
  const [head, arg] = path.split('/');
  if (head === 'new') {
    const query = mark >= 0 ? full.slice(mark + 1) : '';
    const params = new URLSearchParams(query);
    const web = (v: string | null) => (v && /^https?:\/\//i.test(v) ? v : undefined);
    // "#/new?images=…&title=…&page=…&next=…": sent by the WebTrad bookmark.
    const images = (params.get('images') ?? '').split('\n').map((l) => l.trim()).filter((l) => web(l));
    if (images.length > 0) {
      return {
        name: 'new',
        key: query,
        handoff: { images, title: params.get('title') ?? undefined, page: web(params.get('page')), next: web(params.get('next')), cover: web(params.get('cover')) },
      };
    }
    // "#/new?url=…" opens the import screen on a chapter link.
    const url = web(params.get('url'));
    return url ? { name: 'new', url, key: query } : { name: 'new', key: '' };
  }
  if (head === 'settings') return { name: 'settings' };
  if (head === 'log') return { name: 'log' };
  if (head === 'read' && arg) return { name: 'reader', id: decodeURIComponent(arg) };
  if (head === 'series' && arg) return { name: 'series', key: decodeURIComponent(arg) };
  return { name: 'library' };
}

function subscribe(cb: () => void) {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return parseRoute(hash);
}

export function navigate(path: string): void {
  window.location.hash = path.startsWith('#') ? path : `#${path}`;
}
