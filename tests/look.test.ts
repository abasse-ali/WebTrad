import { describe, expect, it } from 'vitest';
import { inpaintText, sampleInk, type Pixels } from '../src/lib/imageproc';
import { cleanLine } from '../src/lib/text';

/** Builds an image from a function giving the colour of each pixel. */
function image(w: number, h: number, at: (x: number, y: number) => [number, number, number]): Pixels {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = at(x, y);
      data.set([r, g, b, 255], (y * w + x) * 4);
    }
  }
  return { data, width: w, height: h };
}

const WOOD = (_x: number, y: number): [number, number, number] => (y % 4 < 2 ? [107, 68, 35] : [122, 82, 48]);
const inLetters = (x: number, y: number) => y >= 12 && y < 28 && x >= 10 && x < 70 && x % 12 < 6;

describe('sampleInk', () => {
  it('finds the colour of lettering on a sign', () => {
    const px = image(80, 40, (x, y) => (inLetters(x, y) ? [255, 213, 74] : WOOD(x, y)));
    const ink = sampleInk(px, { x: 5, y: 8, w: 70, h: 24 }, '#734b29');
    expect(ink?.color).toBe('#ffd54a');
    expect(ink?.tones).toHaveLength(1);
  });

  it('snaps near-black and near-white and reports outlines', () => {
    const black = image(80, 40, (x, y) => (inLetters(x, y) ? [20, 18, 22] : [255, 255, 255]));
    expect(sampleInk(black, { x: 0, y: 0, w: 80, h: 40 }, '#ffffff')?.color).toBe('#111111');
    // White letters with a black outline over mid-grey artwork.
    const outlined = image(80, 40, (x, y) => {
      if (inLetters(x, y)) return [250, 250, 250];
      if (y >= 8 && y < 32 && x >= 6 && x < 74 && (x + 3) % 12 < 12) return [15, 15, 15];
      return [120, 110, 100];
    });
    const ink = sampleInk(outlined, { x: 0, y: 0, w: 80, h: 40 }, '#786e64');
    expect(ink?.color).toBe('#ffffff');
    expect(ink?.tones).toHaveLength(2);
  });

  it('returns nothing when the box holds no lettering', () => {
    expect(sampleInk(image(40, 20, WOOD), { x: 0, y: 0, w: 40, h: 20 }, '#734b29')).toBeNull();
  });
});

describe('inpaintText', () => {
  it('removes the letters and keeps the artwork around them', () => {
    const px = image(80, 40, (x, y) => (inLetters(x, y) ? [255, 213, 74] : WOOD(x, y)));
    const out = inpaintText(px, { x: 0, y: 0, w: 80, h: 40 }, [[255, 213, 74]], 1)!;
    expect(out.width).toBe(80);
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 80; x++) {
        const i = (y * 80 + x) * 4;
        // Nothing yellow is left, and every pixel is a wood tone again.
        expect(out.data[i + 2]).toBeLessThan(80);
        expect(out.data[i]).toBeGreaterThan(95);
        expect(out.data[i]).toBeLessThan(135);
      }
    }
    // Far from the letters the pixels are untouched.
    expect([...out.data.slice(0, 3)]).toEqual([107, 68, 35]);
  });

  it('only erases inside the allowed band', () => {
    const px = image(80, 40, (x, y) => (inLetters(x, y) ? [255, 213, 74] : WOOD(x, y)));
    const out = inpaintText(px, { x: 0, y: 0, w: 80, h: 40 }, [[255, 213, 74]], 1, (_x, y) => y >= 20)!;
    expect(out.data[(14 * 80 + 12) * 4 + 2]).toBe(74); // above the band: still a letter
    expect(out.data[(26 * 80 + 12) * 4 + 2]).toBeLessThan(80);
  });

  it('gives up when there is nothing to rebuild from', () => {
    const flat = image(20, 20, () => [255, 213, 74]);
    expect(inpaintText(flat, { x: 0, y: 0, w: 20, h: 20 }, [[255, 213, 74]], 1)).toBeNull();
    expect(inpaintText(image(20, 20, WOOD), { x: 0, y: 0, w: 20, h: 20 }, [[255, 213, 74]], 1)).toBeNull();
  });
});

describe('cleanLine', () => {
  it('reads a lone bar before a word as the pronoun I', () => {
    const latin = { script: /[A-Za-z]/u };
    expect(cleanLine('| am waiting at the station.', latin)).toBe('I am waiting at the station.');
    expect(cleanLine('WHAT | SAID', latin)).toBe('WHAT SAID');
  });
});
