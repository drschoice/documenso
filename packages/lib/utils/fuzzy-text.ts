/**
 * Matching names that different people typed: case, accents and punctuation
 * don't count, and a typo costs a fraction of the word it's in.
 */

/** Lower case, accents dropped, every run of other characters one space. */
export const normalizeText = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export const textWords = (text: string) => normalizeText(text).split(' ').filter(Boolean);

/** The normalized text with its spaces taken out: "North Wind" is "northwind". */
export const squashText = (text: string) => normalizeText(text).replace(/ /g, '');

/**
 * Typos between two strings: a letter added, dropped or changed, or two
 * neighbouring letters swapped ("tabel" for "table") each count as one.
 * Optimal string alignment distance.
 */
export const typoDistance = (a: string, b: string): number => {
  const d: number[][] = [];

  for (let i = 0; i <= a.length; i++) {
    d.push([i]);
  }

  for (let j = 1; j <= b.length; j++) {
    d[0][j] = j;
  }

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;

      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);

      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }

  return d[a.length][b.length];
};

/**
 * 1 for the same string, less 1/length for each typo, never below 0; 0 when
 * either is empty. At 0.75 a word of 4+ letters may have one typo and a word
 * of 8+ two, while a two- or three-letter code has to be exact.
 */
export const textSimilarity = (a: string, b: string) => {
  if (!a || !b) {
    return 0;
  }

  return Math.max(0, 1 - typoDistance(a, b) / Math.max(a.length, b.length));
};

/** Words that don't tell one name from another: "The House of Cards Company" is "house cards". */
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'the',
  'of',
  'for',
  'in',
  'on',
  'to',
  'by',
  'inc',
  'co',
  'corp',
  'corporation',
  'company',
  'llc',
  'ltd',
]);

/**
 * A name's words without the stop words, or all of them if that leaves none,
 * so a folder named "To" still has a word to be named by.
 */
export const tellingWords = (text: string) => {
  const words = textWords(text);
  const telling = words.filter((word) => !STOP_WORDS.has(word));

  return telling.length > 0 ? telling : words;
};
