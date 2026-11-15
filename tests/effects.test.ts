import { describe, expect, it } from 'vitest';
import { isDrawnEffect, isWatermark } from '../src/lib/text';

describe('isDrawnEffect', () => {
  it('recognises drawn effects and cries', () => {
    for (const t of ['HUFF', 'HUFF HUFF', 'SHLICK', 'CLENCH~', 'HAAA', 'HNNG!', 'UGH', 'AH...', 'TZZT', 'SPUUURT', 'WHAAAM!', 'RUB RUB'])
      expect(isDrawnEffect(t), t).toBe(true);
  });
  it('keeps signs and sentences', () => {
    for (const t of ['ORDER HERE', 'PC Cafe', 'BLUE TEAM’S TOWER WAS DESTROYED', 'SMALLBUTSTRONG HAS DISCONNECTED', 'I need to stay calm!', 'EXIT'])
      expect(isDrawnEffect(t), t).toBe(false);
  });
});

describe('isWatermark', () => {
  it('spots website marks', () => {
    for (const t of ['TOOMICS.com', 'toomics . com', 'manhwa18.net', 'Read on Toongod']) expect(isWatermark(t), t).toBe(true);
    for (const t of ['I came here to read a manga', 'Fuck... whatever...']) expect(isWatermark(t), t).toBe(false);
  });
});
