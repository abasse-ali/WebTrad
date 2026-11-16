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
  it('keeps tall pages, other widths and gaps in the order apart', () => {
    expect(pageGroups([page(0, 800, 1800), page(1, 800, 1045)]).length).toBe(2);
    expect(pageGroups([page(0, 800, 900), page(1, 690, 900)]).length).toBe(2);
    expect(pageGroups([page(0, 800, 900), page(2, 800, 900)]).length).toBe(2);
  });
});
