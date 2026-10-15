// lib/fileFinder/triage.ts — what a drive listing contains, before anyone
// reads a page. Pure. Duplicates by bytes, files already in the system by
// bytes, probable drawings by name, copier-named scans nobody will ever find
// by name, empties, and the folders that look personal.

import type { ListedFile } from "./dirTree";

export interface Triage {
  files: number;
  folders: number;
  hashed: number;
  empty: number;
  duplicateGroups: number;
  duplicateFiles: number;
  /** Files whose bytes are already a controlled document. */
  knownInSystem: number;
  drawingLike: number;
  copierLike: number;
  personalFolders: string[];
  topFolders: Array<{ path: string; count: number }>;
  /** The copier-named files, worth reading first. */
  readFirst: ListedFile[];
}

export const isDrawingLike = (n: string) => /\.(dwg|dxf|dgn)$/i.test(n) || /\b(pid|p&id|iso|pfd|plot|gad?)\b/i.test(n) || /^\d{2,4}[-_][A-Z]{1,3}[-_]\d{3,6}/i.test(n) || /\bsht?\s*\d{1,3}\b/i.test(n);
export const isCopierLike = (n: string) => /^(scan|doc|img|image|oc|dsc|copy|untitled)[-_ ]?\d{2,}\b/i.test(n) || /^\d{8,}\.(pdf|tif|tiff|jpg)$/i.test(n);
export const isPersonalFolder = (p: string) => /\b[A-Z][a-z]+'?s\b|\b(my|personal|misc|temp|old|new folder|stuff)\b/i.test(p);

export function triageListing(files: ListedFile[], folders: string[], systemHashes: Set<string>): Triage {
  const byHash = new Map<string, ListedFile[]>();
  for (const f of files) if (f.hash) (byHash.get(f.hash) ?? byHash.set(f.hash, []).get(f.hash)!).push(f);
  const groups = [...byHash.values()].filter((g) => g.length > 1);
  const perFolder = new Map<string, number>();
  for (const f of files) { const k = f.path.join("/") || "(root)"; perFolder.set(k, (perFolder.get(k) ?? 0) + 1); }
  const readFirst = files.filter((f) => isCopierLike(f.name) && (f.sizeBytes ?? 1) > 0 && !(f.hash && systemHashes.has(f.hash)));
  return {
    files: files.length, folders: folders.length,
    hashed: files.filter((f) => !!f.hash).length,
    empty: files.filter((f) => f.sizeBytes === 0).length,
    duplicateGroups: groups.length,
    duplicateFiles: groups.reduce((s, g) => s + g.length - 1, 0),
    knownInSystem: files.filter((f) => f.hash && systemHashes.has(f.hash)).length,
    drawingLike: files.filter((f) => isDrawingLike(f.name)).length,
    copierLike: files.filter((f) => isCopierLike(f.name)).length,
    personalFolders: folders.filter(isPersonalFolder).slice(0, 20),
    topFolders: [...perFolder.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([path, count]) => ({ path, count })),
    readFirst: readFirst.slice(0, 50),
  };
}
