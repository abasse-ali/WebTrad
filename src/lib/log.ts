/**
 * Activity log of the app: what it did, when, with which engine or model,
 * how long it took and what failed. Kept on the device only (localStorage),
 * shown in Settings → Activity log, and exportable as text to report a
 * problem. API keys are never written: values that look like keys are masked.
 */
import { useSyncExternalStore } from 'react';

export type LogLevel = 'info' | 'warn' | 'error';

/** Areas of the app, used to filter the log. */
export type LogCategory = 'app' | 'import' | 'ocr' | 'ia' | 'translate' | 'job' | 'export' | 'settings' | 'voix';

export interface LogEntry {
  /** Time in ms since 1970. */
  t: number;
  level: LogLevel;
  cat: LogCategory;
  msg: string;
  data?: Record<string, string | number | boolean | undefined>;
}

const KEY = 'webtrad.log.v1';
const MAX = 2000;

function load(): LogEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as LogEntry[]) : [];
    return Array.isArray(list) ? list.slice(-MAX) : [];
  } catch {
    return [];
  }
}

let entries: LogEntry[] = typeof localStorage === 'undefined' ? [] : load();
let snapshot: readonly LogEntry[] = entries.slice();
const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function save(): void {
  if (saveTimer) return;
  // Written at most once a second: a translating chapter logs a lot.
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      localStorage.setItem(KEY, JSON.stringify(entries));
    } catch {
      // Storage full: keep the most recent half.
      entries = entries.slice(-Math.floor(MAX / 2));
      try {
        localStorage.setItem(KEY, JSON.stringify(entries));
      } catch {
        /* the log lives in memory only */
      }
    }
  }, 1000);
}

/** Masks anything that looks like a secret (API keys, bearer tokens). */
export function redact(value: string): string {
  return value
    .replace(/\b(nvapi|sk-or|sk|gsk|AIza)[-_A-Za-z0-9]{8,}/g, (m) => `${m.slice(0, 6)}…`)
    .replace(/(Bearer\s+)\S+/gi, '$1…');
}

function clean(data: LogEntry['data']): LogEntry['data'] {
  if (!data) return undefined;
  const out: NonNullable<LogEntry['data']> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === '') continue;
    if (/key|token|secret|password|authorization/i.test(k)) continue;
    out[k] = typeof v === 'string' ? redact(v).slice(0, 300) : v;
  }
  return out;
}

export function log(level: LogLevel, cat: LogCategory, msg: string, data?: LogEntry['data']): void {
  entries.push({ t: Date.now(), level, cat, msg: redact(msg).slice(0, 500), data: clean(data) });
  if (entries.length > MAX) entries = entries.slice(-MAX);
  snapshot = entries.slice();
  listeners.forEach((l) => l());
  save();
}

export const logInfo = (cat: LogCategory, msg: string, data?: LogEntry['data']) => log('info', cat, msg, data);
export const logWarn = (cat: LogCategory, msg: string, data?: LogEntry['data']) => log('warn', cat, msg, data);
export const logError = (cat: LogCategory, msg: string, data?: LogEntry['data']) => log('error', cat, msg, data);

export function clearLog(): void {
  entries = [];
  snapshot = [];
  listeners.forEach((l) => l());
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export function useLog(): readonly LogEntry[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
  );
}

/** "2026-11-15 01:22:07.431" in local time. */
export function formatTime(t: number): string {
  const d = new Date(t);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export function formatData(data: LogEntry['data']): string {
  return data
    ? Object.entries(data)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')
    : '';
}

/** The log as plain text, one line per entry, oldest first. */
export function logAsText(list: readonly LogEntry[]): string {
  return list.map((e) => `${formatTime(e.t)} ${e.level.toUpperCase().padEnd(5)} [${e.cat}] ${e.msg}${e.data ? ' · ' + formatData(e.data) : ''}`).join('\n');
}

/** Milliseconds since `start`, rounded. */
export const since = (start: number) => Math.round(performance.now() - start);

let installed = false;

/** Records uncaught errors and the start of the app. */
export function installLogging(info: Record<string, string>): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  logInfo('app', 'Démarrage de l’appli', info);
  window.addEventListener('error', (e) => logError('app', `Erreur : ${e.message}`, { source: e.filename?.split('/').pop(), line: e.lineno }));
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason as Error | string | undefined;
    if ((reason as Error)?.name === 'AbortError') return;
    logError('app', `Erreur non gérée : ${typeof reason === 'string' ? reason : (reason?.message ?? String(reason))}`);
  });
}
