import { describe, expect, it } from 'vitest';
import { snapToText } from '../src/lib/imageproc';

/** White image with black vertical strokes (fake letters) in a band. */
function page(w: number, h: number, band: { x: number; y: number; w: number; h: number }) {
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  for (let y = band.y; y < band.y + band.h; y++)
    for (let x = band.x; x < band.x + band.w; x++)
      if ((x - band.x) % 4 < 2) {
        const i = (y * w + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = 0;
      }
  return { data, width: w, height: h };
}

describe('snapToText', () => {
  it('moves a box placed a line too high onto the letters', () => {
    const px = page(200, 200, { x: 40, y: 100, w: 100, h: 12 });
    const s = snapToText(px, { x: 40, y: 86, w: 100, h: 12 });
    expect(Math.abs(s.y - 100)).toBeLessThanOrEqual(1);
    expect(Math.abs(s.x - 40)).toBeLessThanOrEqual(2);
  });
  it('keeps a box that is already on its text, or has nothing near it', () => {
    const px = page(200, 200, { x: 40, y: 100, w: 100, h: 12 });
    expect(snapToText(px, { x: 40, y: 100, w: 100, h: 12 }).y).toBe(100);
    expect(snapToText(px, { x: 40, y: 20, w: 100, h: 12 }).y).toBe(20);
  });
});
