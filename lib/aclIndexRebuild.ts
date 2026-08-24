// lib/aclIndexRebuild.ts — SERVER-ONLY.
//
// DEC-10 / DB-4: rebuild every node's `acl_index` from its ACL plus the
// resolved ancestor chain, org by org, filtering expired rules (OWN-7). Run
// from the nightly maintenance cron.
//
// Two defects this repairs:
//   · DB-4 — `acl_index` is written per node at creation and never recomputed
//     when an ancestor's ACL changes, so a library-level revoke never reaches
//     descendants already indexed.
//   · OWN-7 — the index builder used to keep expired rules, so an expired
//     grant kept authorizing forever.
//
// Safety: the recompute uses the SAME chain-merge as construction
// (buildAclIndexFromChain) plus the expiry filter, so for correct, unexpired
// data it reproduces the stored index exactly — the rebuild only WRITES a node
// whose recomputed index differs from what is stored. It is therefore
// idempotent and a no-op for already-correct nodes, which bounds the blast
// radius to genuinely stale/expired indexes.
//
// This narrows the stale-grant window from "forever" to "one cron cycle"; it
// is not a full fix (the index still carries no expiry, so the raw evaluator
// remains the source of truth between cycles).

import type { SupabaseClient } from "@supabase/supabase-js";
import { buildAclIndexFromChain } from "@/lib/acl";
import type { AccessControl, AclIndex } from "@/types/schema";

type LibRow = { id: string; acl: AccessControl | null; acl_index: AclIndex | null };
type FolderRow = { id: string; library_id: string; path_ids: string[] | null; acl: AccessControl | null; acl_index: AclIndex | null };
type DocRow = { id: string; library_id: string; collection_id: string | null; acl: AccessControl | null; acl_index: AclIndex | null };

export interface RebuildCounts { libraries: number; folders: number; documents: number; orgs: number }

// Stable-key JSON compare: the index buckets are plain nested string arrays, so
// a deterministic serialization is enough to tell "changed" from "same".
function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return [...v].map(sortValue).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.keys(o).sort().reduce<Record<string, unknown>>((acc, k) => { acc[k] = sortValue(o[k]); return acc; }, {});
  }
  return v;
}
function indexEqual(a: AclIndex | null, b: AclIndex | null): boolean {
  return JSON.stringify(sortValue(a ?? null)) === JSON.stringify(sortValue(b ?? null));
}

/**
 * Recompute and persist `acl_index` for every library, folder and document in
 * every org. Returns the number of nodes whose index actually changed.
 * `nowMs` defaults to the current time; pass it for deterministic tests.
 */
export async function rebuildAclIndexes(
  sb: SupabaseClient,
  nowMs: number,
): Promise<RebuildCounts> {
  const counts: RebuildCounts = { libraries: 0, folders: 0, documents: 0, orgs: 0 };

  const { data: orgRows } = await sb.from("orgs").select("id");
  const orgIds = ((orgRows ?? []) as Array<{ id: string }>).map((o) => o.id);

  for (const orgId of orgIds) {
    counts.orgs += 1;

    const [{ data: libs }, { data: folders }, { data: docs }] = await Promise.all([
      sb.from("libraries").select("id, acl, acl_index").eq("org_id", orgId),
      sb.from("collections").select("id, library_id, path_ids, acl, acl_index").eq("org_id", orgId),
      sb.from("documents").select("id, library_id, collection_id, acl, acl_index").eq("org_id", orgId),
    ]);

    const libById = new Map<string, LibRow>(((libs ?? []) as LibRow[]).map((l) => [l.id, l]));
    const folderById = new Map<string, FolderRow>(((folders ?? []) as FolderRow[]).map((f) => [f.id, f]));

    // A folder's ancestor chain: library ACL, then each ancestor folder ACL in
    // path order, then the folder's own ACL. `path_ids` holds the ancestor
    // folder ids in root→leaf order (excluding self).
    const folderChain = (f: FolderRow): Array<AccessControl | undefined> => {
      const chain: Array<AccessControl | undefined> = [libById.get(f.library_id)?.acl ?? undefined];
      for (const pid of f.path_ids ?? []) chain.push(folderById.get(pid)?.acl ?? undefined);
      chain.push(f.acl ?? undefined);
      return chain;
    };

    // Libraries: chain is just the library's own ACL.
    for (const l of libById.values()) {
      const next = buildAclIndexFromChain([l.acl ?? undefined], nowMs);
      if (indexEqual(next, l.acl_index)) continue;
      const { error } = await sb.from("libraries").update({ acl_index: next }).eq("id", l.id);
      if (!error) counts.libraries += 1;
    }

    for (const f of folderById.values()) {
      const next = buildAclIndexFromChain(folderChain(f), nowMs);
      if (indexEqual(next, f.acl_index)) continue;
      const { error } = await sb.from("collections").update({ acl_index: next }).eq("id", f.id);
      if (!error) counts.folders += 1;
    }

    for (const d of (docs ?? []) as DocRow[]) {
      const chain: Array<AccessControl | undefined> = [libById.get(d.library_id)?.acl ?? undefined];
      if (d.collection_id) {
        const f = folderById.get(d.collection_id);
        if (f) { for (const pid of f.path_ids ?? []) chain.push(folderById.get(pid)?.acl ?? undefined); chain.push(f.acl ?? undefined); }
      }
      chain.push(d.acl ?? undefined);
      const next = buildAclIndexFromChain(chain, nowMs);
      if (indexEqual(next, d.acl_index)) continue;
      const { error } = await sb.from("documents").update({ acl_index: next }).eq("id", d.id);
      if (!error) counts.documents += 1;
    }
  }

  return counts;
}
