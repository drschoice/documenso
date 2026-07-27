import { describe, expect, it } from 'vitest';

import type { FolderNode } from './build-folder-paths';
import { buildFolderPathMap, collectFolderSubtree } from './build-folder-paths';

describe('buildFolderPathMap', () => {
  it('builds full ancestor paths for arbitrarily deep nesting', () => {
    const folders: FolderNode[] = [
      { id: 'a', name: 'ClientA', parentId: null },
      { id: 'b', name: 'Contracts', parentId: 'a' },
      { id: 'c', name: '2026', parentId: 'b' },
      { id: 'd', name: 'NDA', parentId: 'c' },
    ];

    const map = buildFolderPathMap(folders);

    expect(map.get('a')).toBe('ClientA');
    expect(map.get('b')).toBe('ClientA / Contracts');
    expect(map.get('c')).toBe('ClientA / Contracts / 2026');
    expect(map.get('d')).toBe('ClientA / Contracts / 2026 / NDA');
  });

  it('handles multiple independent roots', () => {
    const folders: FolderNode[] = [
      { id: 'a', name: 'Alpha', parentId: null },
      { id: 'b', name: 'Beta', parentId: null },
      { id: 'a1', name: 'Child', parentId: 'a' },
    ];

    const map = buildFolderPathMap(folders);

    expect(map.get('a')).toBe('Alpha');
    expect(map.get('b')).toBe('Beta');
    expect(map.get('a1')).toBe('Alpha / Child');
  });

  it('treats a folder with a missing parent as the visible root of its chain', () => {
    const folders: FolderNode[] = [
      // parent 'ghost' is not present in the list
      { id: 'x', name: 'Orphan', parentId: 'ghost' },
      { id: 'y', name: 'Leaf', parentId: 'x' },
    ];

    const map = buildFolderPathMap(folders);

    expect(map.get('x')).toBe('Orphan');
    expect(map.get('y')).toBe('Orphan / Leaf');
  });

  it('is resilient to accidental cycles (does not loop forever)', () => {
    const folders: FolderNode[] = [
      { id: 'a', name: 'A', parentId: 'b' },
      { id: 'b', name: 'B', parentId: 'a' },
    ];

    const map = buildFolderPathMap(folders);

    // Both resolve to a finite path; the exact order depends on the start node,
    // but each must contain both names and terminate.
    expect(map.get('a')?.split(' / ').sort()).toEqual(['A', 'B']);
    expect(map.get('b')?.split(' / ').sort()).toEqual(['A', 'B']);
  });

  it('supports a custom separator', () => {
    const folders: FolderNode[] = [
      { id: 'a', name: 'A', parentId: null },
      { id: 'b', name: 'B', parentId: 'a' },
    ];

    expect(buildFolderPathMap(folders, '/').get('b')).toBe('A/B');
  });
});

describe('collectFolderSubtree', () => {
  const folders: FolderNode[] = [
    { id: 'root', name: 'Root', parentId: null },
    { id: 'a', name: 'A', parentId: 'root' },
    { id: 'b', name: 'B', parentId: 'root' },
    { id: 'a1', name: 'A1', parentId: 'a' },
    { id: 'a2', name: 'A2', parentId: 'a' },
    { id: 'a1x', name: 'A1X', parentId: 'a1' },
    { id: 'other', name: 'Other', parentId: null },
  ];

  it('returns the folder plus all of its descendants', () => {
    expect(collectFolderSubtree(folders, 'a').sort()).toEqual(['a', 'a1', 'a1x', 'a2']);
  });

  it('returns the whole tree when starting from the root', () => {
    expect(collectFolderSubtree(folders, 'root').sort()).toEqual([
      'a',
      'a1',
      'a1x',
      'a2',
      'b',
      'root',
    ]);
  });

  it('returns just the folder itself for a leaf', () => {
    expect(collectFolderSubtree(folders, 'a1x')).toEqual(['a1x']);
  });

  it('returns just the id when it is not present in the list', () => {
    expect(collectFolderSubtree(folders, 'missing')).toEqual(['missing']);
  });

  it('does not cross into sibling subtrees', () => {
    expect(collectFolderSubtree(folders, 'a')).not.toContain('b');
    expect(collectFolderSubtree(folders, 'a')).not.toContain('other');
  });
});
