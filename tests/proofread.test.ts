import { describe, expect, it } from 'vitest';
import { acceptedFix } from '../src/lib/translate/llm';

describe('acceptedFix', () => {
  it('keeps a spelling fix, in capitals like the lettering', () => {
    expect(acceptedFix("T'ES SORDE OU QUOI ?!", "T'es sourde ou quoi ?!")).toBe("T'ES SOURDE OU QUOI ?!");
    expect(acceptedFix('Tu as les cooties !', 'Tu as des microbes !')).toBe('Tu as des microbes !');
  });
  it('drops a rewrite, an empty answer or the same line', () => {
    expect(acceptedFix('Arrête !', 'Arrête tout de suite, je ne le répéterai pas !')).toBeUndefined();
    expect(acceptedFix('Arrête !', '')).toBeUndefined();
    expect(acceptedFix('ARRÊTE !', 'Arrête !')).toBeUndefined();
  });
});
