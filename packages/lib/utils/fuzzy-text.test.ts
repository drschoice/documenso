import { describe, expect, it } from 'vitest';

import {
  normalizeText,
  squashText,
  tellingWords,
  textSimilarity,
  typoDistance,
} from './fuzzy-text';

describe('typoDistance', () => {
  it('counts a swap of neighbouring letters as one typo', () => {
    expect(typoDistance('table', 'tabel')).toBe(1);
  });

  it('counts added, dropped and changed letters', () => {
    expect(typoDistance('kitten', 'sitting')).toBe(3);
    expect(typoDistance('', 'abc')).toBe(3);
    expect(typoDistance('abc', 'abc')).toBe(0);
  });
});

describe('textSimilarity', () => {
  it('takes 1/length off per typo', () => {
    expect(textSimilarity('table', 'tabel')).toBe(0.8);
    expect(textSimilarity('table', 'table')).toBe(1);
  });

  it('leaves two-letter codes no room for a typo', () => {
    expect(textSimilarity('ab', 'ac')).toBe(0.5);
    expect(textSimilarity('ab', 'cd')).toBe(0);
  });

  it('is 0 when either side is empty', () => {
    expect(textSimilarity('', 'x')).toBe(0);
  });
});

describe('normalizeText and squashText', () => {
  it('drops case, accents and punctuation', () => {
    expect(normalizeText('  House-of  Cards (Inc.) ')).toBe('house of cards inc');
    expect(normalizeText('Café')).toBe('cafe');
  });

  it('squashes the spaces out', () => {
    expect(squashText('North Wind')).toBe('northwind');
  });
});

describe('tellingWords', () => {
  it('drops the stop words', () => {
    expect(tellingWords('The House of Cards Company')).toEqual(['house', 'cards']);
  });

  it('keeps a name made only of stop words', () => {
    expect(tellingWords('To')).toEqual(['to']);
  });
});
