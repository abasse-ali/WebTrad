import { describe, expect, it } from 'vitest';
import { balanceLines, isAllCaps, wrapText } from '../src/lib/layout';

describe('lettering', () => {
  const measure = (s: string) => s.length * 10;

  it('balances lines instead of leaving an orphan word', () => {
    const text = 'Qu’est-ce que tu fais ici si tard ?';
    const greedy = wrapText(text, 290, measure, 'fr', false);
    // The wrapper ties « ? » to its word with a no-break space.
    expect(greedy).toEqual(['Qu’est-ce que tu fais ici si', 'tard\u00a0?']);
    const balanced = balanceLines(text, greedy, 290, measure, 'fr', false);
    expect(balanced).toHaveLength(2);
    expect(balanced.join(' ')).toBe(greedy.join(' '));
    const widths = balanced.map(measure);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(80);
    expect(Math.max(...widths)).toBeLessThanOrEqual(290);
  });

  it('leaves single lines and unbreakable text alone', () => {
    expect(balanceLines('Salut', ['Salut'], 100, measure, 'fr', false)).toEqual(['Salut']);
    const split = wrapText('Anticonstitutionnellement oui', 100, measure, 'fr', false);
    expect(balanceLines('Anticonstitutionnellement oui', split, 100, measure, 'fr', false)).toEqual(split);
  });

  it('recognises capitals-only lettering', () => {
    expect(isAllCaps('WHAT ARE YOU DOING HERE?')).toBe(true);
    expect(isAllCaps('R-REALLY?!')).toBe(true);
    expect(isAllCaps('What are you doing?')).toBe(false);
    expect(isAllCaps('안녕하세요')).toBe(false);
    expect(isAllCaps('OK')).toBe(false);
  });
});

describe('fitToShape', () => {
  it('wraps the lines to the width a round bubble has at their height', async () => {
    const { fitToShape } = await import('../src/lib/layout');
    // A circle of radius 100 centred on (200, 200), rows every 4 px.
    const x: number[] = [];
    for (let y = 100; y <= 300; y += 4) {
      const half = Math.sqrt(Math.max(0, 100 * 100 - (y - 200) ** 2));
      x.push(Math.round(200 - half), Math.round(200 + half));
    }
    const shape = { y: 100, step: 4, x };
    const measure = (s: string) => s.length * 8;
    const text = 'TU N’AS PAS COURS CE MATIN ? LÈVE-TOI SI TU NE VEUX PAS EN ÊTRE POUR TES FRAIS !';
    const fit = fitToShape(text, shape, 14, measure, 'fr', false, 200)!;
    expect(fit).not.toBeNull();
    const flat = (s: string) => s.replace(/\s+/gu, ' ');
    expect(flat(fit.lines.join(' '))).toBe(flat(text));
    fit.lines.forEach((line, i) => {
      // Every line within the circle at the top and the bottom of its own row.
      for (const y of [fit.top + i * fit.lineH, fit.top + (i + 1) * fit.lineH]) {
        const half = Math.sqrt(Math.max(0, 100 * 100 - (y - 200) ** 2));
        expect(measure(line)).toBeLessThanOrEqual(half * 2 + 8);
      }
    });
    // Middle lines are longer than the first one.
    expect(Math.max(...fit.lines.map((l) => l.length))).toBeGreaterThan(fit.lines[0].length);
    // Too big a size does not fit at all.
    expect(fitToShape(text, shape, 60, (s) => s.length * 34, 'fr', false, 200)).toBeNull();
  });
});
