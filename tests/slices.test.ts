import { describe, expect, it } from 'vitest';
import { sliceLayout } from '../src/lib/pipeline';

describe('sliceLayout', () => {
  it('reads a page a little taller than one slice in one request', () => {
    // Family with Benefits: 800×1828 pages were read in two requests, the second a blank strip.
    expect(sliceLayout(800, 1828)).toEqual({ sliceH: 1828, overlap: 0, count: 1 });
  });

  it('cuts a long page in slices of equal height that cover it', () => {
    const { sliceH, overlap, count } = sliceLayout(800, 6000);
    expect(count).toBeGreaterThan(1);
    expect(sliceH).toBeLessThanOrEqual(800 * 2.2);
    expect(sliceH * count - overlap * (count - 1)).toBeGreaterThanOrEqual(6000);
    // No last slice much smaller than the others.
    expect(6000 - (sliceH - overlap) * (count - 1)).toBeGreaterThan(sliceH * 0.9);
  });
});
