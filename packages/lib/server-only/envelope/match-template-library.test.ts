import { describe, expect, it } from 'vitest';

import { type TemplateLibraryRow, matchTemplateLibrary } from './match-template-library';

const row = (path: string, title: string): TemplateLibraryRow => {
  const folders = path ? path.split('/') : [];

  return { id: [...folders, title].join('/'), title, folderId: path, path: folders };
};

const RENEWAL_2025 =
  'Acme Europe Renewal Pack - for renewals June 1, 2025 - May 1, 2026 effective dates.pdf';
const RENEWAL_2024 =
  'Acme Europe Renewal Pack - for renewals June 1, 2024 - May 1, 2025 effective dates.pdf';

/** Contracts filed by region, department and client, with one client folder misspelt (GOLBEX). */
const LIBRARY = [
  row('Shared (All Regions)', 'Northwind Mutual NDA'),
  row('EU/Sales/Acme', RENEWAL_2024),
  row('EU/Sales/Acme', RENEWAL_2025),
  row('EU/Sales/Initech', 'Initech Master Services Agreement'),
  row('EU/Sales/Umbrella Group', 'UG Order Form'),
  row('EU/Legal/Initech', 'Initech Data Processing Addendum'),
  row('EU/Legal/Northwind', 'NW Legal Review Checklist'),
  row('US/Sales/Initech', 'Initech US Sales Agreement'),
  row('US/Legal/GOLBEX', 'Globex Engagement Letter'),
];

// What a caller might know about each region and department, sent along with the client.
const REGION_WORDS = { EU: 'EU Europe', US: 'US United States' };
const DEPARTMENT_WORDS = { sales: 'Sales Commercial', legal: 'Legal Counsel' };

/** A query carrying everything the caller knows: the client, the region and the department. */
const callerQuery = (
  client: string,
  region: keyof typeof REGION_WORDS,
  department: keyof typeof DEPARTMENT_WORDS,
) => `${client} ${REGION_WORDS[region]} ${DEPARTMENT_WORDS[department]}`;

const top = (query: string, n = 1) =>
  matchTemplateLibrary(LIBRARY, { query })
    .data.slice(0, n)
    .map((match) => match.id);

describe('matchTemplateLibrary', () => {
  it('finds a folder through legal suffixes and tags', () => {
    for (const client of ['Initech Inc.', 'Initech', 'Initech Inc. (15% Discount)']) {
      expect(top(callerQuery(client, 'EU', 'sales'))).toEqual([
        'EU/Sales/Initech/Initech Master Services Agreement',
      ]);
    }
  });

  it('prefers the template whose path the query names more of', () => {
    expect(top(callerQuery('Initech Inc.', 'EU', 'legal'))).toEqual([
      'EU/Legal/Initech/Initech Data Processing Addendum',
    ]);
    expect(top(callerQuery('Northwind', 'EU', 'legal'))).toEqual([
      'EU/Legal/Northwind/NW Legal Review Checklist',
    ]);
  });

  it('finds a folder from each longer way of naming it', () => {
    const packs = [`EU/Sales/Acme/${RENEWAL_2024}`, `EU/Sales/Acme/${RENEWAL_2025}`];

    for (const client of [
      'Acme Corp Renewals',
      'Acme - Initrode Holdings Company (Standard 15% Discount)',
      'Acme - Initrode',
    ]) {
      expect(top(callerQuery(client, 'EU', 'sales'), 2).sort()).toEqual([...packs].sort());
    }
  });

  it('cannot get from another name for a client to its folder unless told', () => {
    // A trading name is not a typo. Nothing beats the region and department...
    const without = matchTemplateLibrary(LIBRARY, {
      query: callerQuery('Roadrunner Supplies', 'EU', 'sales'),
    });

    expect(without.data[0].score).toBeLessThan(3);

    // ...until the caller sends the name the folder goes by.
    expect(top(callerQuery('Roadrunner Supplies Acme', 'EU', 'sales'))).toEqual([
      `EU/Sales/Acme/${RENEWAL_2024}`,
    ]);
  });

  it('puts the exact title first when the query is a title', () => {
    const result = matchTemplateLibrary(LIBRARY, {
      query: callerQuery(`${RENEWAL_2025} Acme`, 'EU', 'sales'),
    });

    expect(result.data[0].id).toBe(`EU/Sales/Acme/${RENEWAL_2025}`);
    expect(result.data[0].titleScore).toBe(1);
    // Last year's pack differs only by its years, which must match exactly.
    expect(result.data[1].id).toBe(`EU/Sales/Acme/${RENEWAL_2024}`);
    expect(result.data[1].titleScore).toBeLessThan(1);
  });

  it('ignores query words that name nothing', () => {
    expect(top(`Jane Doe ${callerQuery('Initech', 'US', 'sales')} thanks`)).toEqual([
      'US/Sales/Initech/Initech US Sales Agreement',
    ]);
  });

  it('names a misspelt folder, and says how much of each folder it named', () => {
    const result = matchTemplateLibrary(LIBRARY, { query: callerQuery('Globex', 'US', 'legal') });

    expect(result.data[0]).toMatchObject({
      id: 'US/Legal/GOLBEX/Globex Engagement Letter',
      pathScores: [1, 1, 0.833],
      titleScore: 0.333,
      score: 3.166,
    });
  });

  it('names a one-word folder from two query words', () => {
    const result = matchTemplateLibrary(LIBRARY, { query: 'North Wind' });

    expect(result.data[0]).toMatchObject({
      id: 'EU/Legal/Northwind/NW Legal Review Checklist',
      pathScores: [0, 0, 1],
    });
  });

  it('names a folder of several words only as far as the query names it', () => {
    const shared = (query: string) =>
      matchTemplateLibrary(LIBRARY, { query }).data.find(
        (match) => match.id === 'Shared (All Regions)/Northwind Mutual NDA',
      );

    expect(shared('Northwind Shared')?.pathScores).toEqual([0.333]);
    expect(shared('Northwind Shared All Regions')?.pathScores).toEqual([1]);
  });

  it('returns only templates it named something of, and counts them before the limit', () => {
    const result = matchTemplateLibrary(LIBRARY, { query: 'Initech', limit: 2 });

    expect(result.count).toBe(3);
    expect(result.data).toHaveLength(2);
    expect(matchTemplateLibrary(LIBRARY, { query: 'zzzz qqqq' })).toEqual({ data: [], count: 0 });
  });

  it('ranks by score and keeps the library’s order among equal scores', () => {
    const result = matchTemplateLibrary(LIBRARY, { query: 'Sales' });

    expect(result.data.map((match) => match.id)).toEqual([
      'US/Sales/Initech/Initech US Sales Agreement',
      `EU/Sales/Acme/${RENEWAL_2024}`,
      `EU/Sales/Acme/${RENEWAL_2025}`,
      'EU/Sales/Initech/Initech Master Services Agreement',
      'EU/Sales/Umbrella Group/UG Order Form',
    ]);
  });
});
