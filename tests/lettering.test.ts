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
