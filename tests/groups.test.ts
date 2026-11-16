import { describe, expect, it } from 'vitest';
import { pageGroups } from '../src/lib/pipeline';
import type { Page } from '../src/lib/types';

const page = (index: number, width: number, height: number) => ({ id: `p${index}`, index, width, height }) as Page;

describe('pageGroups', () => {
  it('reads short pages of the same width two or three at a time', () => {
    const pages = [0, 1, 2, 3, 4].map((i) => page(i, 800, 1045));
    expect(pageGroups(pages).map((g) => g.map((p) => p.index))).toEqual([[0, 1], [2, 3], [4]]);
    const tiny = [0, 1, 2, 3].map((i) => page(i, 800, 600));
    expect(pageGroups(tiny).map((g) => g.length)).toEqual([3, 1]);
  });
  it('keeps two pages crossed by a text in the same group', () => {
    const pages = [35, 36, 37, 38, 39].map((i) => page(i, 800, 1045));
    // 36 → 37 crossed: 36 leaves the group of 35 and goes with 37.
    const crossed = new Set(['p36']);
    expect(pageGroups(pages, (p) => crossed.has(p.id)).map((g) => g.map((p) => p.index))).toEqual([[35], [36, 37], [38, 39]]);
    // 35 → 36 and 36 → 37 crossed: the three pages together.
    const both = new Set(['p35', 'p36']);
    expect(pageGroups(pages, (p) => both.has(p.id)).map((g) => g.map((p) => p.index))).toEqual([[35, 36, 37], [38, 39]]);
  });
  it('keeps tall pages, other widths and gaps in the order apart', () => {
    expect(pageGroups([page(0, 800, 1800), page(1, 800, 1045)]).length).toBe(2);
    expect(pageGroups([page(0, 800, 900), page(1, 690, 900)]).length).toBe(2);
    expect(pageGroups([page(0, 800, 900), page(2, 800, 900)]).length).toBe(2);
  });
});

describe('withRetries and requests left unanswered', () => {
  it('sends an unanswered image once more at most, and not at all for pages read together', async () => {
    const { withRetries } = await import('../src/lib/pipeline');
    const { TranslateError } = await import('../src/lib/translate/types');
    let calls = 0;
    const hang = async () => {
      calls++;
      throw new TranslateError('AI endpoint unreachable (no complete answer after 90 s).', 'llm', true);
    };
    const signal = new AbortController().signal;
    await expect(withRetries(hang, signal, [0, 0], 0)).rejects.toThrow(/no complete answer/);
    expect(calls).toBe(1);
    calls = 0;
    await expect(withRetries(hang, signal, [0, 0], 1)).rejects.toThrow(/no complete answer/);
    expect(calls).toBe(2);
  });
});
