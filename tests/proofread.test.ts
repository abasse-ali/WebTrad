import { describe, expect, it } from 'vitest';
import { acceptedFix, genderChange, genderFixAllowed } from '../src/lib/translate/llm';

describe('acceptedFix', () => {
  it('keeps a spelling fix, in capitals like the lettering', () => {
    expect(acceptedFix("T'ES SORDE OU QUOI ?!", "T'es sourde ou quoi ?!")).toBe("T'ES SOURDE OU QUOI ?!");
    expect(acceptedFix('Tu as les cooties !', 'Tu as des microbes !')).toBe('Tu as des microbes !');
  });
  it('drops a rewrite, an empty answer or the same line', () => {
    expect(acceptedFix('Arrête !', 'Arrête tout de suite, je ne le répéterai pas !')).toBeUndefined();
    expect(acceptedFix('Arrête !', '')).toBeUndefined();
    expect(acceptedFix('ARRÊTE !', 'Arrête !')).toBeUndefined();
    expect(acceptedFix('BON\nTIMING.', 'BON TIMING.')).toBeUndefined();
    expect(acceptedFix('ARGUE ! ELLE\nVEUT PAS', 'ARGH ! ELLE VEUT PAS')).toBe('ARGH ! ELLE VEUT PAS');
  });
});

describe('changes of gender made by the proofreader', () => {
  it('tells a change of gender from other changes', () => {
    expect(genderChange("T'ES COMPLÈTEMENT FOLLE !", "T'ES COMPLÈTEMENT FOU !")).toBe('m');
    expect(genderChange("J'essaie tellement d'être normale...", "J'essaie tellement d'être normal...")).toBe('m');
    expect(genderChange('POURQUOI TE PROMÈNES-TU TOUJOURS NU ?', 'POURQUOI TE PROMÈNES-TU TOUJOURS NUE ?')).toBe('f');
    expect(genderChange('APRÈS ÊTRE SORTI', 'APRÈS ÊTRE SORTIE')).toBe('f');
    expect(genderChange('CES SAC ONT', 'CES SACS ONT')).toBeNull();
  });
  it('keeps it only when it is known who the words are about', () => {
    // Said to Hanna (a woman): "folle" stays.
    expect(genderFixAllowed("T'ES COMPLÈTEMENT FOLLE !", 'm', 'male', 'female')).toBe(false);
    // Said by Hanna: "normale" stays.
    expect(genderFixAllowed("J'essaie tellement d'être normale...", 'm', 'female')).toBe(false);
    // Said to Hanna: "nu" becomes "nue".
    expect(genderFixAllowed('POURQUOI TE PROMÈNES-TU TOUJOURS NU ?', 'f', 'male', 'female')).toBe(true);
    // Said by Hanna of herself.
    expect(genderFixAllowed('JE ME PROMÈNE NU CHEZ MOI', 'f', 'female')).toBe(true);
    // Nobody known: refused.
    expect(genderFixAllowed('TU ES PRÊT ?', 'f', undefined, undefined)).toBe(false);
  });
});
