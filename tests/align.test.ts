import { describe, expect, it } from 'vitest';
import { alignToBubbles } from '../src/lib/align';
import { evenCutText } from '../src/lib/pipeline';

const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

describe('alignToBubbles', () => {
  // Two bubbles of a slice: texts at y 590 and 1700.
  const bubbles = [box(20, 480, 300, 220), box(260, 1600, 300, 200)];
  it('undoes boxes squeezed towards the middle', () => {
    // The model put them at 940 and 1600 (scale 0.6).
    const items = [box(100, 930, 160, 20), box(330, 1590, 160, 20)];
    const m = alignToBubbles(items, bubbles);
    expect(m.matched).toBe(2);
    expect(Math.abs(m.a * 940 + m.b - 590)).toBeLessThan(5);
    expect(Math.abs(m.a * 1600 + m.b - 1700)).toBeLessThan(5);
  });
  it('keeps boxes that are already right', () => {
    const items = [box(100, 580, 160, 20), box(330, 1690, 160, 20)];
    expect(alignToBubbles(items, bubbles)).toMatchObject({ a: 1, b: 0, matched: 2 });
  });
  it('leaves a sign alone when nothing clearly fits', () => {
    expect(alignToBubbles([box(500, 300, 100, 20)], bubbles)).toMatchObject({ a: 1, b: 0 });
  });
});

describe('splitAtSentence', () => {
  it('cuts at the sentence end closest to the share', async () => {
    const { splitAtSentence } = await import('../src/lib/pipeline');
    expect(splitAtSentence("YOONDA N'ARRÊTAIT PAS DE TE LOUER... JE NE M'ATTENDAIS PAS À ÇA.", 0.55)).toEqual([
      "YOONDA N'ARRÊTAIT PAS DE TE LOUER...",
      "JE NE M'ATTENDAIS PAS À ÇA.",
    ]);
    expect(splitAtSentence('UNE SEULE PHRASE SANS FIN', 0.5)).toBeNull();
  });
});

describe('alignToBubbles with two texts in one shape', () => {
  it('keeps correct boxes of two bubbles drawn joined', () => {
    const joined = [box(40, 0, 560, 520)];
    const items = [box(150, 80, 220, 40), box(300, 290, 240, 60)];
    expect(alignToBubbles(items, joined)).toMatchObject({ a: 1, b: 0, matched: 2 });
  });
});

describe('alignToBubbles and a game chat', () => {
  it('does not squeeze the lines of a chat into one big bubble', () => {
    // Twelve chat lines (light letters on a dark screen: no bubble, no block
    // found under them), and one big white bubble below.
    const lines = Array.from({ length: 12 }, (_, i) => ({ x: 40, y: 100 + i * 60, w: 500, h: 40 }));
    const bubble = { x: 100, y: 900, w: 600, h: 500 };
    const m = alignToBubbles(lines, [bubble]);
    expect(m.a).toBe(1);
    expect(m.b).toBe(0);
  });
});

describe('evenCutText', () => {
  it('gives a line cut by the page edge the usual size of the page', () => {
    const b = (y: number, h: number, fontSize: number) => ({ id: String(y), x: 100, y, w: 300, h, original: '', translation: 'x', fontSize });
    const out = evenCutText([b(0, 20, 9), b(500, 60, 24), b(1200, 60, 26), b(1900, 60, 25)], 2000);
    expect(out[0].fontSize).toBe(25);
    expect(out[1].fontSize).toBe(24);
  });
});
