import { describe, expect, it } from 'vitest';
import { detectAllBubbles, fitShift, lettering, snapToText } from '../src/lib/imageproc';

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

describe('fitShift', () => {
  it('finds a constant offset, ignoring a wrong reading', () => {
    const f = fitShift([
      { at: 100, shift: -20 },
      { at: 400, shift: -21 },
      { at: 800, shift: -19 },
      { at: 900, shift: 60 },
    ]);
    expect(Math.round(f(500))).toBe(-20);
  });
  it('follows boxes that drift more and more down the image', () => {
    const f = fitShift([0, 200, 400, 600, 800].map((at) => ({ at, shift: 5 + at * 0.1 })));
    expect(Math.round(f(1000))).toBe(105);
  });
  it('uses the median with few readings, nothing without any', () => {
    expect(fitShift([{ at: 1, shift: 8 }, { at: 2, shift: 12 }])(5)).toBe(12);
    expect(fitShift([])(5)).toBe(0);
  });
});

describe('snapToText with a wider reach', () => {
  it('finds letters two lines away and says so', () => {
    const px = page(300, 400, { x: 60, y: 200, w: 150, h: 14 });
    const s = snapToText(px, { x: 40, y: 172, w: 150, h: 14 }, { y: 2.5, x: 0.6 });
    expect(s.found).toBe(true);
    expect(Math.abs(s.y - 200)).toBeLessThanOrEqual(1);
    expect(Math.abs(s.x - 60)).toBeLessThanOrEqual(2);
    expect(snapToText(px, { x: 40, y: 20, w: 150, h: 14 }).found).toBe(false);
  });
});

describe('lettering', () => {
  it('keeps the text block, not the specks of a grainy rim', () => {
    const xs: number[] = [];
    const ys: number[] = [];
    // Two lines of letters in the middle of a 300×200 bubble at (100, 100).
    for (const line of [180, 200])
      for (let y = line; y < line + 12; y++)
        for (let x = 190; x < 310; x += 2) {
          xs.push(x);
          ys.push(y);
        }
    // Specks near the rim, far from the text.
    for (const [x, y] of [[115, 112], [380, 285], [384, 290], [120, 280], [370, 110]]) {
      xs.push(x);
      ys.push(y);
    }
    expect(lettering(xs, ys, { x: 100, y: 100, w: 300, h: 200 })).toEqual({ x: 190, y: 180, w: 119, h: 32 });
  });
});

describe('detectAllBubbles and whispered bubbles', () => {
  it('finds a grey glossy bubble on a dark page', () => {
    const W = 400, H = 300;
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const dx = (x - 200) / 150, dy = (y - 150) / 90;
        let v = 90; // dark page
        if (dx * dx + dy * dy <= 1) {
          v = 180 + Math.round(15 * (1 - (y - 60) / 180)); // grey gradient, never white
          if (dy < -0.5 && dy > -0.75) v = 250; // glossy highlight
          // a few lines of black letters
          if ((y >= 135 && y <= 145) || (y >= 155 && y <= 165)) if (x >= 130 && x <= 270 && x % 7 < 2) v = 10;
        }
        data[i] = data[i + 1] = data[i + 2] = v;
        data[i + 3] = 255;
      }
    const found = detectAllBubbles({ data, width: W, height: H });
    expect(found.some((r) => r.x < 120 && r.x + r.w > 280 && r.y < 140 && r.y + r.h > 160)).toBe(true);
  });
});
