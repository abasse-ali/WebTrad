import { describe, expect, it } from 'vitest';
import { parsePosition, serialisePosition } from '../src/lib/progress';
import { guessNextUrl, neighbours, parseChapterTitle } from '../src/lib/series';

describe('parseChapterTitle', () => {
  it('splits a title into series and chapter number', () => {
    expect(parseChapterTitle('Solo Leveling - Chapter 12')).toEqual({ series: 'solo leveling', number: 12 });
    expect(parseChapterTitle('Solo Leveling 110')).toEqual({ series: 'solo leveling', number: 110 });
    expect(parseChapterTitle('series chapter 12')).toEqual({ series: 'series', number: 12 });
    expect(parseChapterTitle('Tour des Dieux – Épisode 7')).toEqual({ series: 'tour des dieux', number: 7 });
    expect(parseChapterTitle('Ch.12.5')).toEqual({ series: '', number: 12.5 });
    expect(parseChapterTitle('Chapitre 3')).toEqual({ series: '', number: 3 });
    expect(parseChapterTitle('나 혼자만 레벨업 12화')).toEqual({ series: '나 혼자만 레벨업', number: 12 });
  });

  it('prefers the number announced as a chapter', () => {
    expect(parseChapterTitle('86 - Chapter 5')).toEqual({ series: '86', number: 5 });
    expect(parseChapterTitle('Chapter 12 - Level 99')).toEqual({ series: '', number: 12 });
    expect(parseChapterTitle('Tower of God S2 Ep 45')).toEqual({ series: 'tower of god s2', number: 45 });
  });

  it('accepts titles without a number', () => {
    expect(parseChapterTitle('One Shot')).toEqual({ series: 'one shot', number: null });
  });
});

describe('neighbours', () => {
  const chapters = [
    { id: 'a', title: 'Hero Saga - Chapter 2' },
    { id: 'b', title: 'Hero Saga - Chapter 10' },
    { id: 'c', title: 'Hero Saga Chapter 1' },
    { id: 'd', title: 'Other Series - Chapter 3' },
    { id: 'e', title: 'One Shot' },
  ];
  it('orders the chapters of a series by number, not by text', () => {
    expect(neighbours(chapters, chapters[0])).toEqual({ previous: chapters[2], next: chapters[1] });
    expect(neighbours(chapters, chapters[1])).toEqual({ previous: chapters[0], next: undefined });
    expect(neighbours(chapters, chapters[2])).toEqual({ previous: undefined, next: chapters[0] });
  });
  it('never links different series or unnumbered chapters', () => {
    expect(neighbours(chapters, chapters[3])).toEqual({ previous: undefined, next: undefined });
    expect(neighbours(chapters, chapters[4])).toEqual({});
  });
});

describe('guessNextUrl', () => {
  it('increments the chapter number of the path', () => {
    expect(guessNextUrl('https://site.example/manga/hero/chapter-12/')).toBe('https://site.example/manga/hero/chapter-13/');
    expect(guessNextUrl('https://site.example/series/chapter-9.html')).toBe('https://site.example/series/chapter-10.html');
    expect(guessNextUrl('https://site.example/hero/ep-009')).toBe('https://site.example/hero/ep-010');
    expect(guessNextUrl('https://site.example/hero/12/read')).toBe('https://site.example/hero/13/read');
    expect(guessNextUrl('https://site.example/hero/chapter12?lang=fr')).toBe('https://site.example/hero/chapter13?lang=fr');
  });
  it('falls back to an episode parameter', () => {
    expect(guessNextUrl('https://site.example/webtoon/detail?titleId=183559&no=12')).toBe(
      'https://site.example/webtoon/detail?titleId=183559&no=13',
    );
    expect(guessNextUrl('https://site.example/viewer?title_no=95&episode_no=7')).toBe(
      'https://site.example/viewer?title_no=95&episode_no=8',
    );
  });
  it('gives up on ids and addresses without a number', () => {
    expect(guessNextUrl('https://site.example/read/5f3a9c12/')).toBeNull();
    expect(guessNextUrl('https://site.example/read/1234567')).toBeNull();
    expect(guessNextUrl('https://site.example/about')).toBeNull();
    expect(guessNextUrl('not a url')).toBeNull();
  });
});

describe('reading position', () => {
  it('round-trips through storage', () => {
    const pos = { page: 4, offset: 0.4217, ratio: 0.31, finished: false };
    expect(parsePosition(serialisePosition(pos))).toEqual({ page: 4, offset: 0.422, ratio: 0.31, finished: false });
    expect(parsePosition(serialisePosition({ ...pos, finished: true }))?.finished).toBe(true);
  });
  it('reads the page index stored by older versions', () => {
    expect(parsePosition('7')).toEqual({ page: 7, offset: 0, ratio: 0, finished: false });
  });
  it('ignores missing or damaged values', () => {
    expect(parsePosition(null)).toBeNull();
    expect(parsePosition('')).toBeNull();
    expect(parsePosition('{"p":-1}')).toBeNull();
    expect(parsePosition('{oops')).toBeNull();
    expect(parsePosition('{"p":2,"o":7,"r":"x"}')).toEqual({ page: 2, offset: 1, ratio: 0, finished: false });
  });
});
