import { describe, expect, it } from 'vitest';
import { DEFAULT_SPEED, SPEED_LEVELS, clampSpeed, scrollSpeed } from '../src/lib/autoscroll';

describe('automatic scrolling speed', () => {
  it('keeps the level in range', () => {
    expect(clampSpeed(0)).toBe(1);
    expect(clampSpeed(99)).toBe(SPEED_LEVELS);
    expect(clampSpeed(3.4)).toBe(3);
    expect(clampSpeed(Number.NaN)).toBe(DEFAULT_SPEED);
    expect(clampSpeed(undefined as unknown as number)).toBe(DEFAULT_SPEED);
  });
  it('gets faster with every level', () => {
    for (let l = 1; l < SPEED_LEVELS; l++) expect(scrollSpeed(l + 1)).toBeGreaterThan(scrollSpeed(l));
    expect(scrollSpeed(1)).toBe(30);
    expect(scrollSpeed(DEFAULT_SPEED)).toBeGreaterThan(50);
    expect(scrollSpeed(SPEED_LEVELS)).toBeLessThan(320);
  });
});
