import { describe, expect, it } from 'vitest';
import { seriesOf } from '../src/lib/series';
import { isDrawnEffect, isScreenChat, isSeriesTitle } from '../src/lib/text';

describe('lettering left as drawn', () => {
  it('knows the series logo, not a line quoting part of it', () => {
    const series = seriesOf('Read Someone Stop Her! Chapter 108 Online').name;
    expect(series).toBe('Someone Stop Her!');
    expect(isSeriesTitle('SOMEONE STOP HER!', series)).toBe(true);
    expect(isSeriesTitle('SOMEONE, STOP HER!', series)).toBe(true);
    expect(isSeriesTitle('STOP HER!', series)).toBe(false);
  });

  it('knows chat lines on a drawn screen', () => {
    expect(isScreenChat('OO: GG EZ')).toBe(true);
    expect(isScreenChat('0O : lol')).toBe(true);
    expect(isScreenChat('OOH: wow')).toBe(false);
  });

  it('keeps drawn effects such as WHISTLE and TWIRL', () => {
    expect(isDrawnEffect('WHISTLE')).toBe(true);
    expect(isDrawnEffect('TWIRL')).toBe(true);
  });
});
