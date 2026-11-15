import { describe, expect, it } from 'vitest';
import { alignToBubbles } from '../src/lib/align';

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
