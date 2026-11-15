/**
 * Counts the requests sent to each AI provider: today (the free tiers of
 * OpenRouter reset at midnight UTC) and over the last minute (20 a minute
 * on free models). Kept on the device; shown in the reader and settings.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';

const KEY = 'webtrad.usage.v1';

interface DayCounts {
  ok: number;
  limited: number;
  failed: number;
}

interface Stored {
  /** UTC day, "2026-11-15". */
  day: string;
  hosts: Record<string, DayCounts>;
}

const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

function load(): Stored {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Stored | null;
    if (raw && raw.day === utcDay() && raw.hosts) return raw;
  } catch {
    /* fresh count */
  }
  return { day: utcDay(), hosts: {} };
}

let stored: Stored = typeof localStorage === 'undefined' ? { day: utcDay(), hosts: {} } : load();
/** Times of the requests of the last minute, per host. */
const recent = new Map<string, number[]>();
const listeners = new Set<() => void>();
let version = 0;

function changed() {
  version++;
  listeners.forEach((l) => l());
}

/** Records one chat request and how it ended. */
export function countRequest(host: string, outcome: 'ok' | 'limited' | 'failed', now = Date.now()): void {
  if (stored.day !== utcDay(now)) stored = { day: utcDay(now), hosts: {} };
  const counts = (stored.hosts[host] ??= { ok: 0, limited: 0, failed: 0 });
  counts[outcome]++;
  if (outcome !== 'limited') {
    const list = (recent.get(host) ?? []).filter((t) => now - t < 60_000);
    list.push(now);
    recent.set(host, list);
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    /* counted in memory only */
  }
  changed();
}

export interface Usage {
  /** Requests answered today (UTC day). */
  today: number;
  /** Requests refused today because of the rate limit. */
  limited: number;
  /** Requests sent over the last 60 seconds. */
  minute: number;
  /** Local time at which the daily count starts again (midnight UTC). */
  resetsAt: Date;
}

export function usageOf(host: string, now = Date.now()): Usage {
  const counts = stored.day === utcDay(now) ? stored.hosts[host] : undefined;
  const midnight = new Date(utcDay(now) + 'T00:00:00Z').getTime() + 86_400_000;
  return {
    today: (counts?.ok ?? 0) + (counts?.failed ?? 0),
    limited: counts?.limited ?? 0,
    minute: (recent.get(host) ?? []).filter((t) => now - t < 60_000).length,
    resetsAt: new Date(midnight),
  };
}

export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** Live usage of a provider; the per-minute count is refreshed every few seconds. */
export function useUsage(host: string): Usage {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(timer);
  }, []);
  return usageOf(host);
}
