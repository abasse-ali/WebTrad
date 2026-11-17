import { describe, expect, it } from 'vitest';
import { frenchSpacing } from '../src/lib/layout';
import { shareInShape, shiftBubble } from '../src/lib/pipeline';
import type { Bubble } from '../src/lib/types';

describe('Family with Benefits, chapter 8', () => {
  it('moves the body of a bubble drawn bigger with the bubble (no empty bubble a panel higher)', () => {
    const b = { id: 'a', x: 10, y: 1200, w: 100, h: 40, original: 'x', translation: 'y', shape: { y: 1180, step: 2, x: [0, 1, 0, 1, 0, 1], body: [0, 1, 0, 1, 0, 1], bodyY: 1185 } } as Bubble;
    const moved = shiftBubble(b, -900);
    expect(moved.y).toBe(300);
    expect(moved.shape!.y).toBe(280);
    expect(moved.shape!.bodyY).toBe(285);
  });

  it('puts the French spaces before ! ? ; : and inside « »', () => {
    expect(frenchSpacing("D'EAU!!")).toBe("D'EAU !!");
    expect(frenchSpacing('HEIN?!')).toBe('HEIN ?!');
    expect(frenchSpacing('fois...?')).toBe('fois... ?');
    expect(frenchSpacing('Artiste: X')).toBe('Artiste : X');
    expect(frenchSpacing('«Bonjour»')).toBe('« Bonjour »');
    expect(frenchSpacing('Déjà bien ! Oui ?')).toBe('Déjà bien ! Oui ?');
    expect(frenchSpacing('12:30')).toBe('12:30');
  });

  it('measures how much of a box lies in the bubble itself, not in its frame', () => {
    // A round bubble 100 wide: rows narrow at the top and bottom.
    const h = 100;
    const spans = new Int32Array(h * 2);
    for (let r = 0; r < h; r++) {
      const half = Math.round(Math.sqrt(Math.max(0, 50 * 50 - (r - 50) ** 2)));
      spans[r * 2] = 50 - half;
      spans[r * 2 + 1] = 50 + half;
    }
    const region = { x: 0, y: 0, w: 100, h, spans, area: 7850 } as unknown as Parameters<typeof shareInShape>[1];
    // A small text in the frame's top-right corner, outside the round shape.
    expect(shareInShape({ x: 85, y: 0, w: 15, h: 10 }, region, 1)).toBeLessThan(0.1);
    expect(shareInShape({ x: 30, y: 40, w: 40, h: 20 }, region, 1)).toBeGreaterThan(0.9);
  });
});
