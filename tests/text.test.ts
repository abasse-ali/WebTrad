import { describe, expect, it } from 'vitest';
import {
  classifyScript,
  cleanLine,
  dedupeBlocks,
  groupLines,
  guessLatinLanguage,
  isMeaningful,
  isNoiseBlock,
  joinLines,
  normaliseCase,
  stripJunkTokens,
  type OcrLine,
} from '../src/lib/text';
import { SOURCE_LANGUAGES } from '../src/lib/languages';

const ko = SOURCE_LANGUAGES.find((l) => l.code === 'ko')!;
const ja = SOURCE_LANGUAGES.find((l) => l.code === 'ja')!;
const en = SOURCE_LANGUAGES.find((l) => l.code === 'en')!;

const line = (x: number, y: number, w: number, h: number, text: string, confidence = 90): OcrLine => ({ x, y, w, h, text, confidence });

describe('groupLines', () => {
  it('merges stacked lines of one bubble and keeps separate bubbles apart', () => {
    // Real Tesseract output for a synthetic webtoon page (two bubbles + caption).
    const lines = [
      line(183, 209, 154, 27, '안녕하세요!'),
      line(183, 246, 156, 27, '오늘 날씨가'),
      line(178, 284, 155, 28, '정말 좋네요.'),
      line(483, 589, 154, 27, '그런데 너는'),
      line(497, 626, 123, 27, '왜 여기에'),
      line(490, 664, 142, 28, '있는 거야?'),
      line(158, 1924, 222, 25, '그날 밤, 모든 것이'),
      line(212, 1961, 115, 25, '바뀌었다.'),
    ];
    const blocks = groupLines(lines, ko);
    expect(blocks.map((b) => b.text)).toEqual([
      '안녕하세요! 오늘 날씨가 정말 좋네요.',
      '그런데 너는 왜 여기에 있는 거야?',
      '그날 밤, 모든 것이 바뀌었다.',
    ]);
    expect(blocks[0]).toMatchObject({ x: 178, y: 209, w: 161, h: 103 });
  });

  it('joins fragments of the same row left to right', () => {
    const blocks = groupLines([line(300, 100, 80, 24, 'HERE?'), line(100, 100, 180, 24, 'WHAT ARE YOU DOING')], en);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe('WHAT ARE YOU DOING HERE?');
  });

  it('does not merge text of very different sizes', () => {
    const blocks = groupLines([line(100, 100, 200, 20, 'small text'), line(100, 125, 300, 70, 'HUGE SFX')], en);
    expect(blocks).toHaveLength(2);
  });

  it('reads vertical columns right to left without spaces', () => {
    const blocks = groupLines([line(100, 100, 30, 200, '元気ですか'), line(140, 100, 30, 200, 'こんにちは')], ja);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].vertical).toBe(true);
    expect(blocks[0].text).toBe('こんにちは元気ですか');
  });
});

describe('text helpers', () => {
  it('cleans CJK spacing and stray border symbols', () => {
    expect(cleanLine('こ ん に ち は', ja)).toBe('こんにちは');
    expect(cleanLine('|안녕하세요', ko)).toBe('안녕하세요');
    expect(cleanLine('  오늘   날씨가 \n', ko)).toBe('오늘 날씨가');
  });

  it('filters garbage that is not in the source script', () => {
    expect(isMeaningful('안녕', ko)).toBe(true);
    expect(isMeaningful('~~ //', ko)).toBe(false);
    expect(isMeaningful('MJ ミ Dio', ko)).toBe(false);
    expect(isMeaningful('OK', en)).toBe(true);
    expect(isMeaningful('1', en)).toBe(false);
  });

  it('joins hyphenated English lines', () => {
    expect(joinLines(['SOME-', 'THING ELSE'], en)).toBe('SOMETHING ELSE');
    expect(joinLines(['元気', 'ですか'], ja)).toBe('元気ですか');
  });

  it('turns comic ALL CAPS into sentence case', () => {
    expect(normaliseCase('WHAT ARE YOU DOING HERE? I TOLD YOU!')).toBe('What are you doing here? I told you!');
    expect(normaliseCase('Already normal text.')).toBe('Already normal text.');
  });

  it('drops boxes duplicated by tile overlaps', () => {
    const out = dedupeBlocks([
      { x: 0, y: 0, w: 100, h: 50 },
      { x: 5, y: 5, w: 80, h: 40 },
      { x: 300, y: 0, w: 50, h: 50 },
    ]);
    expect(out).toHaveLength(2);
  });
});

describe('language detection', () => {
  it('recognises the writing system of OCR output', () => {
    expect(classifyScript('빨리 가자! 그런데 너는')).toBe('ko');
    // Vertical Japanese read with a horizontal model: interleaved but still kana.
    expect(classifyScript('元 こ 気 ん でに す ち かは')).toBe('ja');
    expect(classifyScript('你在这里做什么？我们走吧')).toBe('zh');
    expect(classifyScript('WHAT ARE YOU DOING HERE?')).toBe('latin');
    expect(classifyScript('Что ты здесь делаешь?')).toBe('ru');
    expect(classifyScript('!?')).toBeNull();
  });

  it('keeps Korean with a few hanja as Korean', () => {
    expect(classifyScript('大韓民國 만세! 우리는 이긴다')).toBe('ko');
  });

  it('guesses Latin languages', () => {
    expect(guessLatinLanguage('WHAT ARE YOU DOING HERE? I TOLD YOU TO WAIT')).toBe('en');
    expect(guessLatinLanguage("Qu'est-ce que tu fais là ? Je t'ai dit de m'attendre")).toBe('fr');
    expect(guessLatinLanguage('¿Qué estás haciendo aquí? No lo sé')).toBe('es');
    expect(guessLatinLanguage('Was machst du hier? Ich weiß es nicht')).toBe('de');
    expect(guessLatinLanguage('Anh đang làm gì ở đây? Tôi không biết')).toBe('vi');
  });
});


describe('OCR noise filtering (real manhwa samples)', () => {
  it('removes debris tokens but keeps punctuation that matters', () => {
    expect(stripJunkTokens('I PAID THE “ ] MONEY I OWED THE CYBER | i CAFE...')).toBe('I PAID THE MONEY I OWED THE CYBER CAFE...');
    expect(stripJunkTokens('! TIME TO GET SERIOUS ! ...')).toBe('! TIME TO GET SERIOUS ! ...');
  });

  it('flags short unsure fragments read from the artwork', () => {
    for (const [text, conf] of [
      ['Vy', 61],
      ['Ret', 54],
      ['ADV', 55],
      ['27 Mg', 44],
      ['wo Fh.', 55],
      ['Gs', 40],
      ['RVULP', 74],
    ] as const) {
      expect(isNoiseBlock(text, conf, en), text).toBe(true);
    }
  });

  it('keeps real lettering', () => {
    expect(isNoiseBlock('HAA... FINALLY...', 93, en)).toBe(false);
    expect(isNoiseBlock('NO!', 96, en)).toBe(false);
    expect(isNoiseBlock('FUU... FUCK THE WORLD...', 92, en)).toBe(false);
    expect(isNoiseBlock('빨리 가자!', 95, ko)).toBe(false);
    expect(isNoiseBlock('ㅋ', 50, ko)).toBe(true);
  });
});
