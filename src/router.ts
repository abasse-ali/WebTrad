import { useSyncExternalStore } from 'react';

export type Route =
  | { name: 'library' }
  | { name: 'new'; url?: string }
  | { name: 'settings' }
  | { name: 'reader'; id: string };

export function parseRoute(hash: string): Route {
  const full = hash.replace(/^#\/?/, '');
  const mark = full.indexOf('?');
  const path = mark >= 0 ? full.slice(0, mark) : full;
  const [head, arg] = path.split('/');
  if (head === 'new') {
    // "#/new?url=…" opens the import screen on a chapter link.
    const url = mark >= 0 ? new URLSearchParams(full.slice(mark + 1)).get('url') : null;
    return url && /^https?:\/\//i.test(url) ? { name: 'new', url } : { name: 'new' };
  }
  if (head === 'settings') return { name: 'settings' };
  if (head === 'read' && arg) return { name: 'reader', id: decodeURIComponent(arg) };
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
