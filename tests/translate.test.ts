import { describe, expect, it } from 'vitest';
import { parseJsonAnswer } from '../src/lib/translate/llm';
import { proxied } from '../src/lib/importers';
import { wrapText } from '../src/lib/layout';
import { googleCode, chromeCode } from '../src/lib/languages';

describe('parseJsonAnswer', () => {
  it('accepts fenced and chatty answers', () => {
    expect(parseJsonAnswer('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonAnswer('Sure! Here it is: {"translations":[{"id":1,"text":"Salut"}]} Enjoy')).toEqual({
      translations: [{ id: 1, text: 'Salut' }],
    });
    expect(parseJsonAnswer('[1,2]')).toEqual([1, 2]);
  });
  it('throws on garbage', () => {
    expect(() => parseJsonAnswer('no json here')).toThrow();
  });
});

describe('helpers', () => {
  it('builds proxied URLs', () => {
    expect(proxied('https://a.b/c?d=1', '')).toBe('https://a.b/c?d=1');
    expect(proxied('https://a.b/c', 'https://p.dev/?url={url}')).toBe('https://p.dev/?url=https%3A%2F%2Fa.b%2Fc');
    expect(proxied('https://a.b/c', 'https://p.dev/raw?')).toBe('https://p.dev/raw?https%3A%2F%2Fa.b%2Fc');
  });

  it('maps language codes per engine', () => {
    expect(googleCode('zh-Hans')).toBe('zh-CN');
    expect(googleCode('he')).toBe('iw');
    expect(chromeCode('zh-Hans')).toBe('zh');
    expect(chromeCode('fr')).toBe('fr');
  });

  it('wraps words to the available width', () => {
    const measure = (s: string) => s.length * 10;
    expect(wrapText('Je t’ai dit de m’attendre à la gare', 120, measure, 'fr', false)).toEqual([
      'Je t’ai dit',
      'de',
      'm’attendre à',
      'la gare',
    ]);
    // Too-long word: hard break.
    expect(wrapText('Anticonstitutionnellement', 100, measure, 'fr', false).every((l) => measure(l) <= 100)).toBe(true);
    // Languages without spaces break between characters / words.
    expect(wrapText('こんにちは元気ですか', 50, measure, 'ja', true).join('')).toBe('こんにちは元気ですか');
  });
});

describe('proxy templates', () => {
  it('fills the referer placeholder', () => {
    expect(proxied('https://img.x/1.jpg', 'https://w.dev/?url={url}&referer={referer}', 'https://site.x/ep/1')).toBe(
      'https://w.dev/?url=https%3A%2F%2Fimg.x%2F1.jpg&referer=https%3A%2F%2Fsite.x%2Fep%2F1',
    );
  });
});

describe('guessTitle', () => {
  it('uses folder, archive or URL path names', async () => {
    const { guessTitle } = await import('../src/lib/importers');
    expect(guessTitle('Solo Leveling 110.cbz')).toBe('Solo Leveling 110');
    expect(guessTitle('My_Series/ep-12/001.jpg')).toBe('ep 12');
    expect(guessTitle('https://site.example/series/chapter-12.html')).toBe('series chapter 12');
    expect(guessTitle('https://site.example/')).toBe('site.example');
  });
});

describe('wrapText punctuation', () => {
  const measure = (s: string) => s.length * 10;
  it('keeps detached punctuation with its word', () => {
    expect(wrapText('Où vas-tu ? Attendre', 90, measure, 'fr', false)).toEqual(['Où', 'vas-tu ?', 'Attendre']);
    expect(wrapText('Il a dit « non » !', 200, measure, 'fr', false)).toEqual(['Il a dit « non » !']);
  });
  it('can refuse to split words', () => {
    expect(wrapText('comment', 40, measure, 'fr', false, false)).toBeNull();
  });
});

describe('normaliseSourceCode', () => {
  it('maps AI language tags to source codes', async () => {
    const { normaliseSourceCode } = await import('../src/lib/languages');
    expect(normaliseSourceCode('ko')).toBe('ko');
    expect(normaliseSourceCode('ja-JP')).toBe('ja');
    expect(normaliseSourceCode('zh')).toBe('zh-Hans');
    expect(normaliseSourceCode('zh-TW')).toBe('zh-Hant');
    expect(normaliseSourceCode('zh-Hant')).toBe('zh-Hant');
    expect(normaliseSourceCode('xx')).toBeNull();
    expect(normaliseSourceCode(undefined)).toBeNull();
  });
});
