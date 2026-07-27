export type FolderNode = {
  id: string;
  name: string;
  parentId: string | null;
};

/** Separator used to join ancestor folder names into a path string. */
export const FOLDER_PATH_SEPARATOR = ' / ';

/**
 * Build a map of `folderId → full path string` (e.g. `ClientA / Contracts / 2026`)
 * for every folder in the list, by walking each folder's `parentId` chain upward.
 *
 * Handles arbitrary nesting depth and is resilient to accidental cycles (each walk
 * stops if it revisits a folder). Folders whose parent is missing from the list are
 * simply treated as roots of the visible chain.
 */
export const buildFolderPathMap = (
  folders: FolderNode[],
  separator: string = FOLDER_PATH_SEPARATOR,
): Map<string, string> => {
  const folderById = new Map(folders.map((folder) => [folder.id, folder]));
  const cache = new Map<string, string>();

  const buildPath = (id: string): string => {
    const cached = cache.get(id);

    if (cached !== undefined) {
      return cached;
    }

    const names: string[] = [];
    const seen = new Set<string>();
    let current = folderById.get(id);

    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      names.unshift(current.name);
      current = current.parentId ? folderById.get(current.parentId) : undefined;
    }

    const path = names.join(separator);
    cache.set(id, path);

    return path;
  };

  const result = new Map<string, string>();

  for (const folder of folders) {
    result.set(folder.id, buildPath(folder.id));
  }

  return result;
};

/**
 * Collect a folder and all of its descendants (recursively) as a flat list of ids.
 * Used to scope a search to a folder subtree. Cycle-safe.
 */
export const collectFolderSubtree = (folders: FolderNode[], rootId: string): string[] => {
  const childrenByParent = new Map<string, string[]>();

  for (const folder of folders) {
    if (folder.parentId) {
      const siblings = childrenByParent.get(folder.parentId) ?? [];
      siblings.push(folder.id);
      childrenByParent.set(folder.parentId, siblings);
    }
  }

  const collected: string[] = [];
  const stack = [rootId];
  const visited = new Set<string>();

  while (stack.length > 0) {
    const next = stack.pop()!;

    if (visited.has(next)) {
      continue;
    }

    visited.add(next);
    collected.push(next);
    stack.push(...(childrenByParent.get(next) ?? []));
  }

  return collected;
};
