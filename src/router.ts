import { useSyncExternalStore } from 'react';

export type Route =
  | { name: 'library' }
  | { name: 'new' }
  | { name: 'settings' }
  | { name: 'reader'; id: string };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, '');
  const [head, arg] = path.split('/');
  if (head === 'new') return { name: 'new' };
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
