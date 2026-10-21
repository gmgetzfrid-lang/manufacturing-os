// lib/folderCounts.ts — documents per folder, rolled up the tree.
//
// `direct` holds the documents filed directly in each folder (key null = the
// library's top level). Every folder's total is its own plus everything
// beneath it, so a folder tile can say "1,240 files" for the whole branch.
// Cycle-safe: a corrupted parent chain can't loop forever.

export interface FolderNodeLite { id: string; parentId: string | null }

export function rollupFolderCounts(
  folders: FolderNodeLite[],
  direct: Map<string | null, number>,
): { totals: Map<string, number>; libraryTotal: number } {
  const totals = new Map<string, number>();
  const known = new Set(folders.map((f) => f.id));
  for (const f of folders) totals.set(f.id, direct.get(f.id) ?? 0);
  // Add each folder's OWN count to every ancestor.
  const parentOf = new Map(folders.map((f) => [f.id, f.parentId]));
  for (const f of folders) {
    const own = direct.get(f.id) ?? 0;
    if (!own) continue;
    const seen = new Set<string>([f.id]);
    let p = parentOf.get(f.id) ?? null;
    while (p && known.has(p) && !seen.has(p)) {
      seen.add(p);
      totals.set(p, (totals.get(p) ?? 0) + own);
      p = parentOf.get(p) ?? null;
    }
  }
  let libraryTotal = 0;
  for (const n of direct.values()) libraryTotal += n;
  return { totals, libraryTotal };
}
