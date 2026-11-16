import { describe, expect, it } from 'vitest';
import { cleanPaper, paperShape, plainPaper } from '../src/lib/imageproc';
import { isSoundEffect, tidyTranslation } from '../src/lib/text';

/** White page with fake letters in `band`, and a thin black line crossing it diagonally (a bubble's outline). */
function page(w: number, h: number, band: { x: number; y: number; w: number; h: number }, outline = false) {
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  const ink = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = 0;
  };
  for (let y = band.y; y < band.y + band.h; y++) for (let x = band.x; x < band.x + band.w; x++) if ((x - band.x) % 4 < 2) ink(x, y);
  if (outline) for (let x = 0; x < w; x++) for (let t = 0; t < 2; t++) ink(x, Math.min(h - 1, Math.round(band.y - 6 + (x - band.x) * 0.15) + t));
  return { data, width: w, height: h };
}

describe('lettering on plain paper (Family with Benefits, chapter 6)', () => {
  it('finds the paper around a line of letters, and its room', () => {
    const px = page(300, 200, { x: 100, y: 90, w: 100, h: 20 });
    expect(plainPaper(px, { x: 100, y: 90, w: 100, h: 20 }, 20)).toEqual([255, 255, 255]);
    const room = paperShape(px, { x: 100, y: 90, w: 100, h: 20 }, [255, 255, 255], 60);
    expect(room).not.toBeNull();
    // The same on both sides of the text, further out than the letters.
    const widest = Math.max(...room!.spans.map(([l, r]) => r - l));
    expect(widest).toBeGreaterThan(150);
  });

  it('erases the letters but keeps a bubble outline crossing the box', () => {
    const px = page(300, 200, { x: 100, y: 90, w: 100, h: 20 }, true);
    const box = { x: 90, y: 80, w: 120, h: 40 };
    const out = cleanPaper(px, box, '#ffffff', 36);
    const at = (x: number, y: number) => out.pixels.data[((y - out.y) * out.pixels.width + (x - out.x)) * 4];
    // A letter stroke in the middle of the line is gone…
    expect(at(150, 100)).toBe(255);
    // …the outline, which goes on out of the box, stays.
    const y = Math.round(90 - 6 + (150 - 100) * 0.15);
    expect(at(150, y)).toBe(0);
  });
});

describe('model answers made ready to letter', () => {
  it('drops the flags and line breaks the model added, keeps lettering symbols', () => {
    expect(tidyTranslation("T'ES ENDORMI LÀ-BAS ?! 🇫🇷")).toBe("T'ES ENDORMI LÀ-BAS ?!");
    expect(tidyTranslation('ELLE A DE GROS SEINS ! ET UN\nCUL QUI VA BIEN AVEC.')).toBe('ELLE A DE GROS SEINS ! ET UN CUL QUI VA BIEN AVEC.');
    expect(tidyTranslation('JE SUIS DE RETOUR ! ♡')).toBe('JE SUIS DE RETOUR ! ♡');
    expect(tidyTranslation('SUPER 😀', 'NICE 😀')).toBe('SUPER 😀');
    expect(tidyTranslation('SUPER 😀', 'NICE')).toBe('SUPER');
  });

  it('knows hyphenated and stretched sound effects', () => {
    for (const t of ['TA-DA', 'TADAA', 'DUUN']) expect(isSoundEffect(t)).toBe(true);
    for (const t of ['T-TU', 'H-HANNA!']) expect(isSoundEffect(t)).toBe(false);
  });
});

describe('lettering drawn on the artwork', () => {
  it('sees white letters outlined in black on a light grey wall', async () => {
    const { sampleInk } = await import('../src/lib/imageproc');
    const w = 120;
    const h = 40;
    const data = new Uint8ClampedArray(w * h * 4).fill(222);
    for (let p = 3; p < data.length; p += 4) data[p] = 255;
    const set = (x: number, y: number, v: number) => {
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
    };
    // Five strokes: a white core 4 px wide inside a black outline 2 px wide.
    for (let k = 0; k < 5; k++) {
      const x0 = 12 + k * 20;
      for (let y = 8; y < 32; y++)
        for (let x = x0; x < x0 + 8; x++) set(x, y, x < x0 + 2 || x >= x0 + 6 || y < 10 || y >= 30 ? 20 : 255);
    }
    const ink = sampleInk({ data, width: w, height: h }, { x: 10, y: 5, w: 100, h: 30 }, '#dedede');
    expect(ink?.color).toBe('#ffffff');
    expect(ink?.tones.length).toBe(2);
  });

  it('carries an edge of the drawing through the erased letters', async () => {
    const { inpaintText } = await import('../src/lib/imageproc');
    const w = 60;
    const h = 40;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        // White paper on the left, dark hair on the right.
        const v = x < 30 ? 250 : 60;
        data[i] = data[i + 1] = data[i + 2] = v;
        data[i + 3] = 255;
      }
    // A black letter across the edge.
    for (let y = 15; y < 25; y++)
      for (let x = 22; x < 38; x++) {
        const i = (y * w + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = 0;
      }
    const out = inpaintText({ data, width: w, height: h }, { x: 0, y: 0, w, h }, [[0, 0, 0]], 1)!;
    const at = (x: number, y: number) => out.data[(y * w + x) * 4];
    // Both sides of the edge keep their own colour inside the old letter.
    expect(at(25, 20)).toBeGreaterThan(200);
    expect(at(35, 20)).toBeLessThan(110);
  });
});
