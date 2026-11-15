import { describe, expect, it } from 'vitest';
import { countRequest, usageOf } from '../src/lib/usage';

describe('request counter', () => {
  it('counts today and the last minute, rate-limit refusals apart', () => {
    const now = Date.parse('2026-11-15T13:00:00Z');
    countRequest('openrouter.ai', 'ok', now - 90_000);
    countRequest('openrouter.ai', 'ok', now - 30_000);
    countRequest('openrouter.ai', 'limited', now - 20_000);
    countRequest('openrouter.ai', 'failed', now - 10_000);
    const u = usageOf('openrouter.ai', now);
    expect(u.today).toBe(3);
    expect(u.minute).toBe(2);
    expect(u.limited).toBe(1);
    expect(u.resetsAt.toISOString()).toBe('2026-11-16T00:00:00.000Z');
    expect(usageOf('other.host', now).today).toBe(0);
  });
  it('starts again at midnight UTC', () => {
    expect(usageOf('openrouter.ai', Date.parse('2026-11-16T00:00:05Z')).today).toBe(0);
  });
});
