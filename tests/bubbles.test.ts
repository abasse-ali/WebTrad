import { describe, expect, it } from 'vitest';
import { cleanBubble, detectAllBubbles, enclosingBubble, inpaintText, maskedCrop, regionFill, type Pixels } from '../src/lib/imageproc';

type Rgb = [number, number, number];

/** Builds an image from a function giving the colour of each pixel. */
function image(w: number, h: number, at: (x: number, y: number) => Rgb): Pixels {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = at(x, y);
      data.set([r, g, b, 255], (y * w + x) * 4);
    }
  }
  return { data, width: w, height: h };
}

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [10, 10, 10];
const PINK: Rgb = [240, 130, 120];
/** A line of "letters": small marks side by side. */
const letters = (x: number, y: number, x0: number, y0: number, w: number, h: number) =>
  y >= y0 && y < y0 + h && x >= x0 && x < x0 + w && (x - x0) % 8 < 5;
const colourAt = (px: Pixels, x: number, y: number): number[] => Array.from(px.data.slice((y * px.width + x) * 4, (y * px.width + x) * 4 + 3));

describe('enclosingBubble', () => {
  // A shout bubble: a diamond (half of its box, so not found as a bubble) on light grey.
  const d = (x: number, y: number) => Math.abs(x - 120) / 100 + Math.abs(y - 90) / 70;
  const shout = image(240, 180, (x, y) => {
    if (letters(x, y, 84, 82, 72, 14)) return BLACK;
    if (d(x, y) < 0.94) return WHITE;
    if (d(x, y) < 1) return BLACK;
    return [212, 212, 212];
  });

  it('finds a bubble of an unusual shape from its lettering', () => {
    expect(detectAllBubbles(shout)).toHaveLength(0);
    const region = enclosingBubble(shout, { x: 84, y: 82, w: 72, h: 14 })!;
    expect(region).not.toBeNull();
    expect(region.x).toBeGreaterThan(20);
    expect(region.x + region.w).toBeLessThan(220);
    expect(region.w).toBeGreaterThan(150);
    expect(region.ink).toBeGreaterThan(100);
  });

  it('lets the lettering be erased without touching the outline', () => {
    const region = enclosingBubble(shout, { x: 84, y: 82, w: 72, h: 14 })!;
    const ink = maskedCrop(shout, region).ink!;
    const cleaned = cleanBubble(shout, region, { x: ink.x - 6, y: ink.y - 6, w: ink.w + 12, h: ink.h + 12 }, regionFill(shout, region));
    // The letters are gone…
    for (let i = 0; i < cleaned.pixels.data.length; i += 4) expect(cleaned.pixels.data[i]).toBeGreaterThan(200);
    // …and the outline, outside the cleaned box, was never part of it.
    expect(cleaned.y).toBeGreaterThan(region.y);
    expect(cleaned.pixels.height).toBeLessThan(region.h);
  });

  it('is not fooled by the paper of the page', () => {
    // Letters on a white page that runs far above and below: no bubble.
    const page = image(100, 400, (x, y) => (letters(x, y, 20, 195, 60, 10) ? BLACK : WHITE));
    expect(enclosingBubble(page, { x: 20, y: 195, w: 60, h: 10 })).toBeNull();
    // Lettering on shaded artwork: no bubble either.
    const shaded = image(160, 120, (x, y) => (letters(x, y, 40, 55, 80, 10) ? BLACK : y < 4 || y > 115 || x < 4 || x > 155 ? BLACK : [205 + ((x * 7 + y * 3) % 50), 205 + ((x * 7 + y * 3) % 50), 205 + ((x * 7 + y * 3) % 50)]));
    expect(enclosingBubble(shaded, { x: 40, y: 55, w: 80, h: 10 })).toBeNull();
  });
});

describe('bubbles lettered in colour', () => {
  const inBubble = (x: number, y: number) => ((x - 100) / 80) ** 2 + ((y - 60) / 45) ** 2;
  const whisper = image(200, 120, (x, y) => {
    if (letters(x, y, 64, 54, 72, 12)) return PINK;
    if (inBubble(x, y) < 0.92) return WHITE;
    if (inBubble(x, y) < 1) return PINK;
    return [110, 100, 105];
  });

  it('are found, with their lettering', () => {
    const regions = detectAllBubbles(whisper);
    expect(regions).toHaveLength(1);
    expect(regions[0].tinted).toBe(true);
    const ink = maskedCrop(whisper, regions[0]).ink!;
    expect(ink.x).toBeGreaterThanOrEqual(60);
    expect(ink.x + ink.w).toBeLessThanOrEqual(140);
    expect(ink.h).toBeLessThan(20);
  });

  it('stay plain bubbles when their lettering is dark', () => {
    const plain = image(200, 120, (x, y) => {
      if (letters(x, y, 64, 54, 72, 12)) return BLACK;
      if (inBubble(x, y) < 0.92) return WHITE;
      if (inBubble(x, y) < 1) return BLACK;
      return [110, 100, 105];
    });
    const regions = detectAllBubbles(plain);
    expect(regions).toHaveLength(1);
    expect(regions[0].tinted).toBeUndefined();
  });
});

describe('inpaintText with a letter size', () => {
  const WOOD = (y: number): Rgb => (y % 4 < 2 ? [107, 68, 35] : [122, 82, 48]);
  // Black letters on wood, under a black line that crosses the whole box (an outline).
  const sign = image(120, 60, (x, y) => (y >= 6 && y < 9 ? BLACK : letters(x, y, 20, 28, 80, 12) ? BLACK : WOOD(y)));

  it('erases the letters and keeps the line that crosses the box', () => {
    const out = inpaintText(sign, { x: 0, y: 0, w: 120, h: 60 }, [BLACK], 1, undefined, 20)!;
    expect(colourAt(out, 60, 7)[0]).toBeLessThan(40); // the line is still there
    expect(colourAt(out, 22, 33)[0]).toBeGreaterThan(90); // the letters are wood again
  });

  it('erases everything of the ink colour when no size is given', () => {
    const out = inpaintText(sign, { x: 0, y: 0, w: 120, h: 60 }, [BLACK], 1)!;
    expect(colourAt(out, 60, 7)[0]).toBeGreaterThan(90);
  });
});
