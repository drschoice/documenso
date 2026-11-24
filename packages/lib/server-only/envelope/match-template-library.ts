import {
  squashText,
  tellingWords,
  textSimilarity,
  textWords,
  typoDistance,
} from '../../utils/fuzzy-text';

/**
 * Finding templates deep in a folder library from a free-text query that may
 * name the folders a template sits in and words of its title, among words
 * that name nothing. "Initech Inc. (renewal) EU Europe Sales" should find
 * `EU / Sales / Initech / <title>`.
 *
 * - Each folder on a template's path, and its title, scores 0 to 1 by how much
 *   of it the query names: the share of its words found in the query, typos
 *   allowed ("Globex" names "GOLBEX"), or the whole name with its spaces taken
 *   out ("North Wind" names "Northwind"). Numbers must match exactly: 2025 is
 *   not a typo of 2026.
 * - A template scores the sum, so naming three folders on its path beats
 *   naming one, and a folder the query doesn't name costs nothing.
 * - Query words that name nothing cost nothing either, so a caller can send
 *   everything it has: legal suffixes, tags, a code and the name it stands
 *   for, several names for one thing.
 *
 * Nothing here knows what a folder level means. Another name for the same
 * thing (an abbreviation, a trading name) is not a typo; the caller has to
 * send the name the folder goes by.
 *
 * Kept free of the database so it can be tested on its own;
 * `searchTemplateLibrary` feeds it the library.
 */

/** How alike two words must be to count: one typo in 4+ letters, two in 8+, short codes exact. */
export const TEMPLATE_MATCH_THRESHOLD = 0.75;

export const TEMPLATE_SEARCH_DEFAULT_LIMIT = 25;

/** The longest run of query words compared as one squashed name. */
const MAX_RUN = 4;

export type TemplateLibraryRow = {
  id: string;
  title: string;
  folderId: string;
  /** Folder names below the library's root, outermost first. */
  path: string[];
};

export type TemplateLibraryCriteria = {
  query: string;
  limit?: number;
  threshold?: number;
};

export type TemplateLibraryMatch = TemplateLibraryRow & {
  /** The sum of `pathScores` and `titleScore`. */
  score: number;
  /** How much of each folder in `path` the query named, 0 to 1. */
  pathScores: number[];
  /** How much of the title the query named, 0 to 1. */
  titleScore: number;
};

const round = (score: number) => Math.round(score * 1000) / 1000;

const hasDigit = (text: string) => /\d/.test(text);

/**
 * The templates the query names anything of, best first, at most `limit`, and
 * how many there were in all. Ties keep the library's order.
 */
export const matchTemplateLibrary = (
  rows: TemplateLibraryRow[],
  {
    query,
    limit = TEMPLATE_SEARCH_DEFAULT_LIMIT,
    threshold = TEMPLATE_MATCH_THRESHOLD,
  }: TemplateLibraryCriteria,
) => {
  const allQueryWords = textWords(query);
  const queryWords = [...new Set(allQueryWords)];

  // Runs of consecutive query words with the spaces taken out, so a one-word
  // folder name can be named by two query words, and the other way round.
  const runs = new Set<string>();

  for (let start = 0; start < allQueryWords.length; start++) {
    for (let length = 1; length <= MAX_RUN && start + length <= allQueryWords.length; length++) {
      runs.add(allQueryWords.slice(start, start + length).join(''));
    }
  }

  const similarity = (a: string, b: string) => {
    if (hasDigit(a) || hasDigit(b)) {
      return a === b ? 1 : 0;
    }

    return textSimilarity(a, b);
  };

  // Folder names and title words repeat across a library, so each is scored once.
  const wordMemo = new Map<string, number>();

  /** How well the query names one word: its closest query word, if close enough. */
  const wordScore = (word: string) => {
    let best = wordMemo.get(word);

    if (best === undefined) {
      best = Math.max(0, ...queryWords.map((queryWord) => similarity(word, queryWord)));
      best = best >= threshold ? best : 0;
      wordMemo.set(word, best);
    }

    return best;
  };

  /** How well a run of query words names the whole name, spaces taken out. */
  const runScore = (name: string) => {
    const squashed = squashText(name);
    let best = 0;

    for (const run of runs) {
      // Lengths more than two apart are more than two typos apart.
      if (Math.abs(run.length - squashed.length) > 2) {
        continue;
      }

      if (hasDigit(run) || hasDigit(squashed)) {
        best = run === squashed ? 1 : best;
        continue;
      }

      const distance = typoDistance(run, squashed);

      if (distance <= 2) {
        best = Math.max(best, 1 - distance / Math.max(run.length, squashed.length));
      }
    }

    return best >= threshold ? best : 0;
  };

  const nameMemo = new Map<string, number>();

  /** How much of a folder name or title the query names, 0 to 1. */
  const nameScore = (name: string) => {
    let score = nameMemo.get(name);

    if (score === undefined) {
      const words = tellingWords(name);
      const covered =
        words.length > 0 ? words.reduce((sum, word) => sum + wordScore(word), 0) / words.length : 0;

      score = round(Math.max(covered, runScore(name)));
      nameMemo.set(name, score);
    }

    return score;
  };

  const matches: TemplateLibraryMatch[] = rows
    .map((row) => {
      const pathScores = row.path.map(nameScore);
      const titleScore = nameScore(row.title);

      return {
        ...row,
        score: round(pathScores.reduce((sum, score) => sum + score, 0) + titleScore),
        pathScores,
        titleScore,
      };
    })
    .filter((match) => match.score > 0);

  // Array.prototype.sort is stable, so equal scores keep the library's order.
  matches.sort((a, b) => b.score - a.score);

  return { data: matches.slice(0, limit), count: matches.length };
};
