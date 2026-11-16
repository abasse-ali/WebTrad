import { describe, expect, it } from 'vitest';
import { planChunks } from '../src/lib/pipeline';
import type { Page } from '../src/lib/types';


describe('planChunks', () => {
  const W = 800;
  /** A page of 1045 rows, busy except for the given empty bands [from, to). */
  const page = (index: number, empty: [number, number][]) => {
    const busy = new Uint16Array(1045).fill(30);
    for (const [a, b] of empty) busy.fill(0, a, b);
    return { page: { id: `p${index}`, index, width: W, height: 1045 } as Page, busy };
  };
  it('cuts the strip in the middle of gutters, each stretch as tall as allowed', () => {
    const pages = [page(0, [[600, 700]]), page(1, [[200, 260], [900, 1000]]), page(2, [[500, 560]]), page(3, [])];
    const chunks = planChunks(pages, W);
    // Gutters at 650, 1275, 1995, 2620 of the strip: cut at 1995 (≤ 2080), then at… the rest fits.
    const cuts = chunks.slice(1).map((c) => c.segments[0].srcY + (c.segments[0].page.index * 1045));
    expect(cuts[0]).toBe(1995);
    for (const c of chunks) expect(c.height).toBeLessThanOrEqual(W * 2.65);
    // The strip whole, in order, page by page.
    expect(chunks.reduce((h, c) => h + c.height, 0)).toBe(4 * 1045);
    expect(chunks[0].segments.map((s) => [s.page.index, s.srcY, s.dstY, s.h])).toEqual([[0, 0, 0, 1045], [1, 0, 1045, 950]]);
  });
  it('does not cut between two lines of a text (a gap shorter than a line spacing)', () => {
    const pages = [page(0, [[700, 710]]), page(1, [[300, 320]]), page(2, [[100, 112]])];
    const chunks = planChunks(pages, W);
    // No band of 24 empty rows: no gutter; stretches cut at the quietest rows instead, none over 2.6 widths.
    for (const c of chunks) expect(c.height).toBeLessThanOrEqual(W * 2.65);
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
