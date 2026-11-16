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

describe('growToText', () => {
  it('covers the lines of a text the box left out, not the drawing beyond', async () => {
    const { growToText } = await import('../src/lib/imageproc');
    const W = 300;
    const H = 300;
    const data = new Uint8ClampedArray(W * H * 4).fill(120);
    // Three lines of letters (vertical strokes) at rows 50, 80 and 110, 16 px tall.
    for (const top of [50, 80, 110])
      for (let y = top; y < top + 16; y++)
        for (let x = 40; x < 240; x++) {
          if (x % 6 < 2) {
            const i = (y * W + x) * 4;
            data[i] = data[i + 1] = data[i + 2] = 250;
          }
        }
    const px = { width: W, height: H, data };
    const out = growToText(px, { x: 40, y: 48, w: 200, h: 20 });
    expect(out.y).toBeLessThanOrEqual(50);
    expect(out.y + out.h).toBeGreaterThanOrEqual(124);
    expect(out.y + out.h).toBeLessThan(140);
    // A box on plain grey stays as it is.
    expect(growToText(px, { x: 40, y: 200, w: 200, h: 20 })).toEqual({ x: 40, y: 200, w: 200, h: 20 });
  });
});

describe('lettersLeft', () => {
  it('finds a line of letters left whole, even when the others are gone', async () => {
    const { lettersLeft } = await import('../src/lib/ocr');
    const W = 100;
    const H = 60;
    const page = new Uint8ClampedArray(W * H * 4).fill(128);
    const stroke = (d: Uint8ClampedArray, top: number) => {
      for (let y = top; y < top + 12; y++) for (let x = 10; x < 90; x += 4) d.set([255, 255, 255, 255], (y * W + x) * 4);
    };
    stroke(page, 5);
    stroke(page, 30);
    const repaired = new Uint8ClampedArray(W * H * 4).fill(128);
    stroke(repaired, 5); // the first line was not taken off
    const area = { x: 0, y: 0, w: W, h: H };
    const px = { width: W, height: H, data: page };
    const out = { width: W, height: H, data: repaired };
    expect(lettersLeft(px, out, area, area)).toBeCloseTo(0.5, 1);
    expect(lettersLeft(px, out, area, area, 20)).toBeGreaterThan(0.9);
    expect(lettersLeft(px, { width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(128) }, area, area, 20)).toBe(0);
  });
});

describe('style of lettering on the artwork', () => {
  // Fake letters: bars 14 px tall, 3 px wide, 8 px apart, on three lines.
  const draw = (angle: number, lean: number) => {
    const W = 400;
    const H = 300;
    const data = new Uint8ClampedArray(W * H * 4).fill(150);
    const t = (angle * Math.PI) / 180;
    for (let line = 0; line < 3; line++)
      for (let k = 0; k < 24; k++)
        for (let dy = 0; dy < 14; dy++)
          for (let dx = 0; dx < 3; dx++) {
            // In the lines' frame: u along the line, v down; leaning letters shift right going up.
            const u = -96 + k * 8 + dx + lean * (14 - dy);
            const v = -40 + line * 30 + dy;
            const x = Math.round(200 + u * Math.cos(t) - v * Math.sin(t));
            const y = Math.round(150 + u * Math.sin(t) + v * Math.cos(t));
            data.fill(20, (y * W + x) * 4, (y * W + x) * 4 + 3);
          }
    return { width: W, height: H, data };
  };
  it('finds the tilt of slanted lines, and none for level ones', async () => {
    const { boxSkew } = await import('../src/lib/imageproc');
    const box = { x: 60, y: 40, w: 280, h: 220 };
    expect(Math.abs(boxSkew(draw(-15, 0), box) + 15)).toBeLessThanOrEqual(2);
    expect(boxSkew(draw(0, 0), box)).toBe(0);
  });
  it('finds italic letters, and none for upright ones', async () => {
    const { boxSlant } = await import('../src/lib/imageproc');
    const box = { x: 60, y: 40, w: 280, h: 220 };
    expect(boxSlant(draw(0, 0.3), box)).toBeGreaterThan(0.2);
    expect(boxSlant(draw(0, 0), box)).toBe(0);
  });
});

describe('growToText sideways', () => {
  it('takes in the ends of lines longer than the box, not the plain background past them', async () => {
    const { growToText } = await import('../src/lib/imageproc');
    const W = 400;
    const H = 200;
    const data = new Uint8ClampedArray(W * H * 4).fill(120);
    for (let y = 80; y < 96; y++)
      for (let x = 60; x < 340; x++) if (x % 6 < 2) data.fill(250, (y * W + x) * 4, (y * W + x) * 4 + 3);
    const out = growToText({ width: W, height: H, data }, { x: 150, y: 78, w: 100, h: 20 });
    expect(out.x).toBeLessThanOrEqual(62);
    expect(out.x + out.w).toBeGreaterThanOrEqual(336);
    expect(out.x).toBeGreaterThan(30);
    expect(out.x + out.w).toBeLessThan(370);
  });
});

describe('growToText next to a sound effect', () => {
  it('stops at strokes that go on above and below the lines', async () => {
    const { growToText } = await import('../src/lib/imageproc');
    const W = 400;
    const H = 200;
    const data = new Uint8ClampedArray(W * H * 4).fill(120);
    for (let y = 80; y < 96; y++)
      for (let x = 150; x < 300; x++) if (x % 6 < 2) data.fill(250, (y * W + x) * 4, (y * W + x) * 4 + 3);
    // A big drawn letter just left of the text, much taller than its line.
    for (let y = 40; y < 140; y++)
      for (let x = 100; x < 140; x++) if (x % 8 < 3) data.fill(20, (y * W + x) * 4, (y * W + x) * 4 + 3);
    const out = growToText({ width: W, height: H, data }, { x: 160, y: 78, w: 100, h: 20 });
    expect(out.x).toBeGreaterThanOrEqual(140);
    expect(out.x + out.w).toBeGreaterThanOrEqual(296);
  });
});

describe('letterHeight', () => {
  it('ignores a short band of shading cut by the box', async () => {
    const { letterHeight } = await import('../src/lib/imageproc');
    const W = 200;
    const H = 120;
    const data = new Uint8ClampedArray(W * H * 4).fill(255);
    const dark = (y0: number, y1: number) => {
      for (let y = y0; y < y1; y++)
        for (let x = 20; x < 180; x++) if (x % 5 < 2) data.fill(0, (y * W + x) * 4, (y * W + x) * 4 + 3);
    };
    dark(10, 32);
    dark(40, 62);
    // Grey shading at the bottom of the bubble, cut by the box.
    for (let y = 70; y < 80; y++) for (let x = 20; x < 180; x++) data.fill(90, (y * W + x) * 4, (y * W + x) * 4 + 3);
    expect(letterHeight({ width: W, height: H, data }, { x: 20, y: 10, w: 160, h: 70 })).toBeGreaterThanOrEqual(20);
  });
});
