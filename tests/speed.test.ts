import { describe, expect, it } from 'vitest';
import { planChunks, sliceLayout } from '../src/lib/pipeline';
import { quotaBackAt, resumeAfterQuota, switchToBackup } from '../src/lib/backup';
import { getSettings, updateSettings } from '../src/lib/settings';
import { isDailyQuota, noteQuotaSpent, fatalReason } from '../src/lib/translate/llm';
import { TranslateError } from '../src/lib/translate/types';
import type { Page } from '../src/lib/types';

describe('a tall panel with no gutter (Family with Benefits, chapters 22 to 27)', () => {
  const W = 800;
  /** A page busy everywhere (a panel of artwork), its gutters and its lettering given. */
  const page = (index: number, h: number, empty: [number, number][], text: [number, number][] = []) => {
    const busy = new Uint16Array(h).fill(300);
    for (const [a, b] of empty) busy.fill(0, a, b);
    const guard = new Uint8Array(h);
    for (const [a, b] of text) guard.fill(1, a, b);
    return { page: { id: `p${index}`, index, width: W, height: h } as Page, busy, guard };
  };

  it('cuts it through its drawing, away from the lettering, in one request instead of two', () => {
    // Gutters at 300 and 3100 only: the passage from 300 had to stretch to
    // 3100 (2800 rows, two slices). Lettering at 2000-2150.
    const pages = [page(0, 1600, [[280, 320]]), page(1, 1600, [[1480, 1520]], [[400, 550]])];
    const before = planChunks(pages.map(({ page, busy }) => ({ page, busy })), W);
    const after = planChunks(pages, W);
    const requests = (cs: typeof after) => cs.reduce((n, c) => n + sliceLayout(c.width, c.height).count, 0);
    expect(requests(after)).toBeLessThan(requests(before));
    for (const c of after) expect(c.height).toBeLessThanOrEqual(W * 2.65);
    // No cut through the lettering (rows 2000 to 2150 of the strip).
    let y = 0;
    for (const c of after.slice(0, -1)) {
      y += c.height;
      expect(y < 2000 || y > 2150).toBe(true);
    }
    expect(after.reduce((h, c) => h + c.height, 0)).toBe(3200);
  });

  it('keeps going to the next gutter when lettering covers every place to cut', () => {
    const pages = [page(0, 1600, [[280, 320]], [[900, 1600]]), page(1, 1600, [[1480, 1520]], [[0, 1480]])];
    const chunks = planChunks(pages, W);
    // The gutter at 3100 of the strip, as before (read in two slices).
    expect(chunks[0].height).toBe(3100);
  });
});

describe('the free quota of the day spent', () => {
  it('is recognised as such', () => {
    const msg = fatalReason(429, '{"error":{"message":"Rate limit exceeded: free-models-per-day"}}')!;
    expect(isDailyQuota(new TranslateError(`${msg} (HTTP 429)`, 'llm', false, true))).toBe(true);
    expect(isDailyQuota(new TranslateError('AI endpoint HTTP 429 (rate limit)', 'llm', true))).toBe(false);
  });

  it('comes back at midnight UTC on OpenRouter', () => {
    const now = Date.UTC(2026, 10, 17, 1, 44);
    expect(quotaBackAt('openrouter', now)).toBe(Date.UTC(2026, 10, 18));
    expect(quotaBackAt('gemini', now)).toBe(Date.UTC(2026, 10, 17, 8));
  });

  it('hands the chapter to NVIDIA, then back to OpenRouter the next day', () => {
    updateSettings({
      ocrEngine: 'vision',
      llm: {
        preset: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'sk-or-1',
        model: 'particle-ai/particle-1:free',
        saved: { nvidia: { apiKey: 'nvapi-1', model: 'nvidia/nemotron-3.5-super-vl-120b-a12b', baseUrl: 'https://integrate.api.nvidia.com/v1' } },
      },
    });
    const now = Date.UTC(2026, 10, 17, 1, 44);
    // Not spent: nothing changes (another page already switched).
    expect(switchToBackup(now)).toMatch(/OpenRouter/);
    expect(getSettings().llm.preset).toBe('openrouter');
    noteQuotaSpent('https://openrouter.ai/api/v1', now);
    expect(switchToBackup(now)).toMatch(/NVIDIA/);
    const llm = getSettings().llm;
    expect([llm.preset, llm.apiKey, llm.model]).toEqual(['nvidia', 'nvapi-1', 'nvidia/nemotron-3.5-super-vl-120b-a12b']);
    expect(llm.saved?.openrouter?.apiKey).toBe('sk-or-1');
    // The same day: NVIDIA stays.
    expect(resumeAfterQuota(now + 3_600_000)).toBeUndefined();
    expect(getSettings().llm.preset).toBe('nvidia');
    // Past midnight UTC: OpenRouter again, its own key and model.
    expect(resumeAfterQuota(Date.UTC(2026, 10, 18, 0, 5))).toMatch(/OpenRouter/);
    const back = getSettings().llm;
    expect([back.preset, back.apiKey, back.model, back.resume]).toEqual(['openrouter', 'sk-or-1', 'particle-ai/particle-1:free', undefined]);
  });

  it('stops when no other provider has a key', () => {
    updateSettings({ ocrEngine: 'vision', llm: { preset: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: 'g', model: 'gemini-flash-latest' } });
    noteQuotaSpent('https://generativelanguage.googleapis.com/v1beta/openai');
    expect(switchToBackup()).toBeUndefined();
    expect(getSettings().llm.preset).toBe('gemini');
  });
});
