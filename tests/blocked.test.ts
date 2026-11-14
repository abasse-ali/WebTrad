import { describe, expect, it } from 'vitest';
import { bookmarkletCode } from '../src/lib/bookmarklet';
import { blockedBy, cleanTitle, pickChapterImages } from '../src/lib/importers';
import { parseRoute } from '../src/router';

describe('blockedBy', () => {
  it('recognises anti-bot pages', () => {
    expect(blockedBy('<html><head><title>Just a moment...</title></head></html>')).toBe('Cloudflare');
    expect(blockedBy('<title>Access denied | www.toongod.org used Cloudflare to restrict access</title>')).toBe('Cloudflare');
    expect(blockedBy('<title>Attention Required! | Cloudflare</title>')).toBe('Cloudflare');
    expect(blockedBy('<title>x</title><script>window._cf_chl_opt={cvId:"3"}</script>')).toBe('Cloudflare');
    expect(blockedBy('<title>DDoS-Guard</title>')).toBe('DDoS-Guard');
  });
  it('leaves real pages alone, even served through Cloudflare', () => {
    expect(blockedBy('<title>Hero Saga - Chapter 12 - Toons</title><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>')).toBeNull();
    expect(blockedBy('<title>Just a moment with you - Chapter 3</title>')).toBeNull();
  });
});

describe('pickChapterImages', () => {
  it('keeps the chapter folder and drops logos', () => {
    const urls = [
      'https://cdn.example/logo.png',
      'https://cdn.example/c12/01.jpg',
      'https://cdn.example/c12/02.jpg',
      'https://cdn.example/c12/02.jpg',
      'https://ads.example/banner.jpg',
      'https://cdn.example/c12/03.jpg',
    ];
    expect(pickChapterImages(urls)).toEqual(['https://cdn.example/c12/01.jpg', 'https://cdn.example/c12/02.jpg', 'https://cdn.example/c12/03.jpg']);
  });
});

describe('cleanTitle', () => {
  it('keeps the series and chapter of a page title', () => {
    expect(cleanTitle('Hero Saga - Chapter 12 - Toons - Read online')).toBe('Hero Saga - Chapter 12');
    expect(cleanTitle('  ')).toBe('');
  });
});

describe('bookmark hand-off', () => {
  it('parses what the bookmark sends', () => {
    const q = new URLSearchParams({
      images: 'https://cdn.example/c12/01.jpg\nhttps://cdn.example/c12/02.jpg\njavascript:alert(1)',
      title: 'Hero Saga - Chapter 12',
      page: 'https://site.example/hero/chapter-12/',
      next: 'javascript:alert(1)',
    });
    const route = parseRoute(`#/new?${q}`);
    expect(route).toMatchObject({
      name: 'new',
      handoff: {
        images: ['https://cdn.example/c12/01.jpg', 'https://cdn.example/c12/02.jpg'],
        title: 'Hero Saga - Chapter 12',
        page: 'https://site.example/hero/chapter-12/',
        next: undefined,
      },
    });
    expect(parseRoute('#/new?url=https%3A%2F%2Fs.example%2Fc%2F1')).toMatchObject({ name: 'new', url: 'https://s.example/c/1' });
    expect(parseRoute('#/new')).toEqual({ name: 'new', key: '' });
  });

  it('builds a bookmark that is valid JavaScript and points at this app', () => {
    const code = bookmarkletCode('https://me.github.io/WebTrad/');
    expect(code.startsWith('javascript:')).toBe(true);
    const source = decodeURIComponent(code.slice('javascript:'.length));
    expect(source).toContain('"https://me.github.io/WebTrad/"');
    expect(() => new Function(source)).not.toThrow();
  });
});
