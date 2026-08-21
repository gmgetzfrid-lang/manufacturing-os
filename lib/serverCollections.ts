// lib/serverCollections.ts — SERVER-ONLY folder-tree maintenance.
//
// collections carries three denormalized path columns (path, path_names,
// path_ids) that every re-parenting operation must rewrite for the whole
// subtree. This helper rebuilds them from the LIVE parent_id tree — the one
// source of truth — so callers (move, delete-with-step-up) can't drift, and
// any stale denorms left by older client-side moves self-heal on the next
// server operation that touches the branch.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface CollectionTreeRow { id: string; parent_id: string | null; name: string }

export interface CollectionTree {
  byId: Map<string, CollectionTreeRow>;
  childrenOf: Map<string | null, CollectionTreeRow[]>;
}

export async function loadCollectionTree(
  admin: SupabaseClient,
  libraryId: string,
): Promise<CollectionTree> {
  const { data, error } = await admin
    .from("collections").select("id, parent_id, name")
    .eq("library_id", libraryId).limit(10000);
  if (error) throw new Error(`Couldn't load the folder tree: ${error.message}`);
  const rows = (data ?? []) as CollectionTreeRow[];
  // A truncated tree would silently rewrite SHORTENED paths for nodes whose
  // ancestors fell past the cap — corrupting data instead of erroring.
  if (rows.length >= 10000) {
    throw new Error("This library has 10,000+ folders — tree operations need a larger read window. Contact support.");
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const childrenOf = new Map<string | null, CollectionTreeRow[]>();
  for (const r of rows) {
    const k = r.parent_id ?? null;
    const arr = childrenOf.get(k);
    if (arr) arr.push(r); else childrenOf.set(k, [r]);
  }
  return { byId, childrenOf };
}

/** Ancestor names + ids for a node (excluding the node itself), walked from
 *  the live tree. Broken ancestry degrades to root-attached, matching the
 *  library page's orphan recovery. */
export function ancestryOf(tree: CollectionTree, id: string): { names: string[]; ids: string[] } {
  const names: string[] = [];
  const ids: string[] = [];
  let cur = tree.byId.get(id);
  for (let hops = 0; cur?.parent_id && hops < 200; hops++) {
    const p = tree.byId.get(cur.parent_id);
    if (!p) break;
    names.unshift(p.name);
    ids.unshift(p.id);
    cur = p;
  }
  return { names, ids };
}

/** Every id in the subtrees rooted at rootIds (roots included), BFS over the
 *  live parent_id tree. Throws past `cap` — a runaway guard, not a quota. */
export function subtreeIds(tree: CollectionTree, rootIds: string[], cap = 5000): string[] {
  const out: string[] = [...rootIds];
  for (let i = 0; i < out.length; i++) {
    for (const child of tree.childrenOf.get(out[i]) ?? []) out.push(child.id);
    if (out.length > cap) throw new Error("Folder tree too large for one operation.");
  }
  return out;
}

/** Rewrite path/path_names/path_ids for every node in the given subtrees.
 *  Chunked; fails loudly on the first write error. */
export async function rebuildSubtreePaths(
  admin: SupabaseClient,
  tree: CollectionTree,
  rootIds: string[],
): Promise<number> {
  const ids = subtreeIds(tree, rootIds);
  for (let i = 0; i < ids.length; i += 25) {
    const chunk = ids.slice(i, i + 25);
    const results = await Promise.all(chunk.map((id) => {
      const row = tree.byId.get(id);
      if (!row) return Promise.resolve({ error: null });
      const anc = ancestryOf(tree, id);
      const pathNames = [...anc.names, row.name];
      return admin.from("collections")
        .update({ path: pathNames, path_names: pathNames, path_ids: anc.ids })
        .eq("id", id);
    }));
    const failed = results.find((r) => (r as { error: { message: string } | null }).error);
    if (failed) {
      const err = (failed as { error: { message: string } }).error;
      throw new Error(`Couldn't rewrite subtree paths: ${err.message}`);
    }
  }
  return ids.length;
}
