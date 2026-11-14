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
    expect(cleanLine('WHAT | SAID', latin)).toBe('WHAT I SAID');
    expect(cleanLine('| CAN’T BELIEVE 1 CAME', latin)).toBe('I CAN’T BELIEVE I CAME');
    expect(cleanLine('THERE 1S NO END', latin)).toBe('THERE IS NO END');
    expect(cleanLine('CHAPTER 10', latin)).toBe('CHAPTER 10');
    expect(cleanLine('|...', latin)).toBe('I...');
    expect(cleanLine('l…', latin)).toBe('I…');
  });
});

describe('textSkew', () => {
  it('measures the tilt of lettering from its ink', async () => {
    const { textSkew } = await import('../src/lib/imageproc');
    const W = 200;
    const H = 120;
    for (const angle of [-8, 0, 6]) {
      const t = (angle * Math.PI) / 180;
      // Two "lines" of dashes (letters) tilted by `angle` around the centre.
      const px = image(W, H, (x, y) => {
        const dx = x - 100;
        const dy = y - 60;
        const u = dx * Math.cos(t) + dy * Math.sin(t);
        const v = -dx * Math.sin(t) + dy * Math.cos(t);
        const inLine = (Math.abs(v + 12) < 4 || Math.abs(v - 12) < 4) && Math.abs(u) < 70 && Math.abs(u) % 10 < 6;
        return inLine ? [20, 20, 20] : [255, 255, 255];
      });
      const spans = new Int32Array(H * 2);
      for (let r = 0; r < H; r++) {
        spans[r * 2] = 0;
        spans[r * 2 + 1] = W - 1;
      }
      const region = { x: 0, y: 0, w: W, h: H, spans, area: W * H, inkBox: { x: 15, y: 15, w: 170, h: 90 }, ink: 1000 };
      expect(Math.abs(textSkew(px, region) - angle)).toBeLessThanOrEqual(1);
    }
  });
});
