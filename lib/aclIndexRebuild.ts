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
// Because a rebuilt index REPLACES the stored one, this loop must never run
// against partial data: a read that fails or truncates would recompute
// indexes with ancestor rules missing and persist them (dropped denies fail
// open; dropped allows lock users out). Hence every read is paginated past
// PostgREST's row cap and error-checked — an org whose reads fail is skipped
// whole and reported, and a node whose ancestor rows are missing (dangling
// library_id / path_ids) is skipped and reported rather than rebuilt as if
// the ancestor had no ACL.
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
type SetRow = { id: string; library_id: string; acl: AccessControl | null; acl_index: AclIndex | null };

export interface RebuildCounts {
  libraries: number;
  folders: number;
  documents: number;
  sets: number;
  orgs: number;
  /** Read failures (org skipped), write failures (node kept stale), and
   *  dangling-ancestor skips. Empty means every node was fully processed. */
  errors: string[];
}

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

// Supabase caps a single request (default 1000 rows); a truncated read here
// would silently strip the unfetched ancestors' rules from every descendant's
// rebuilt index. Page explicitly, and throw on any page error — the caller
// skips the org rather than proceeding on partial data.
const PAGE = 1000;
async function readAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message?: string } | null }>,
  what: string,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(`${what}: ${error.message ?? "read failed"}`);
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return rows;
}

const MAX_ERRORS = 50;

/**
 * Recompute and persist `acl_index` for every library, folder, document and
 * document set in every org. Returns the number of nodes whose index actually
 * changed, plus every error encountered — the cron surfaces those in its
 * `errors` list so a stale (possibly fail-open) index is never a silent
 * success. `nowMs` is the expiry clock; pass a fixed value for deterministic
 * tests.
 */
export async function rebuildAclIndexes(
  sb: SupabaseClient,
  nowMs: number,
): Promise<RebuildCounts> {
  const counts: RebuildCounts = { libraries: 0, folders: 0, documents: 0, sets: 0, orgs: 0, errors: [] };
  const note = (msg: string) => {
    if (counts.errors.length < MAX_ERRORS) counts.errors.push(msg);
    else if (counts.errors.length === MAX_ERRORS) counts.errors.push("…more errors truncated");
  };

  let orgIds: string[];
  try {
    orgIds = (await readAll<{ id: string }>((from, to) => sb.from("orgs").select("id").range(from, to), "orgs")).map((o) => o.id);
  } catch (e) {
    note((e as Error).message);
    return counts;
  }

  for (const orgId of orgIds) {
    let libRows: LibRow[], folderRows: FolderRow[], docRows: DocRow[], setRows: SetRow[];
    try {
      [libRows, folderRows, docRows, setRows] = await Promise.all([
        readAll<LibRow>((f, t) => sb.from("libraries").select("id, acl, acl_index").eq("org_id", orgId).range(f, t), `libraries(org ${orgId})`),
        readAll<FolderRow>((f, t) => sb.from("collections").select("id, library_id, path_ids, acl, acl_index").eq("org_id", orgId).range(f, t), `collections(org ${orgId})`),
        readAll<DocRow>((f, t) => sb.from("documents").select("id, library_id, collection_id, acl, acl_index").eq("org_id", orgId).range(f, t), `documents(org ${orgId})`),
        readAll<SetRow>((f, t) => sb.from("document_sets").select("id, library_id, acl, acl_index").eq("org_id", orgId).range(f, t), `document_sets(org ${orgId})`),
      ]);
    } catch (e) {
      // Never rebuild an org from partial data — a missing table's rules
      // would be stripped from every rebuilt index and the diff guard would
      // happily persist that.
      note(`org ${orgId} skipped: ${(e as Error).message}`);
      continue;
    }
    counts.orgs += 1;

    const libById = new Map<string, LibRow>(libRows.map((l) => [l.id, l]));
    const folderById = new Map<string, FolderRow>(folderRows.map((f) => [f.id, f]));

    const write = async (table: "libraries" | "collections" | "documents" | "document_sets", id: string, next: AclIndex | null): Promise<boolean> => {
      const { error } = await sb.from(table).update({ acl_index: next }).eq("id", id);
      if (error) { note(`${table} ${id}: write failed — ${error.message}`); return false; }
      return true;
    };

    // A folder's ancestor chain: library ACL, then each ancestor folder ACL in
    // path order, then the folder's own ACL. `path_ids` holds the ancestor
    // folder ids in root→leaf order (excluding self). Returns null when an
    // ancestor row is missing (dangling reference) — the caller skips the
    // node instead of rebuilding it as if the ancestor carried no rules.
    const folderChain = (f: FolderRow): Array<AccessControl | undefined> | null => {
      const lib = libById.get(f.library_id);
      if (!lib) return null;
      const chain: Array<AccessControl | undefined> = [lib.acl ?? undefined];
      for (const pid of f.path_ids ?? []) {
        const anc = folderById.get(pid);
        if (!anc) return null;
        chain.push(anc.acl ?? undefined);
      }
      chain.push(f.acl ?? undefined);
      return chain;
    };

    // Libraries: chain is just the library's own ACL.
    for (const l of libById.values()) {
      const next = buildAclIndexFromChain([l.acl ?? undefined], nowMs);
      if (indexEqual(next, l.acl_index)) continue;
      if (await write("libraries", l.id, next)) counts.libraries += 1;
    }

    for (const f of folderById.values()) {
      const chain = folderChain(f);
      if (!chain) { note(`collections ${f.id}: dangling ancestor — skipped`); continue; }
      const next = buildAclIndexFromChain(chain, nowMs);
      if (indexEqual(next, f.acl_index)) continue;
      if (await write("collections", f.id, next)) counts.folders += 1;
    }

    for (const d of docRows) {
      const lib = libById.get(d.library_id);
      if (!lib) { note(`documents ${d.id}: dangling library ${d.library_id} — skipped`); continue; }
      const chain: Array<AccessControl | undefined> = [lib.acl ?? undefined];
      if (d.collection_id) {
        const f = folderById.get(d.collection_id);
        // A missing parent folder is dangling data; a null one (root docs
        // store collection_id = null and never reach here) is not.
        if (!f) { note(`documents ${d.id}: dangling folder ${d.collection_id} — skipped`); continue; }
        const parent = folderChain(f);
        if (!parent) { note(`documents ${d.id}: dangling ancestor via folder ${f.id} — skipped`); continue; }
        // parent already starts with the library ACL and ends with f's own.
        chain.length = 0;
        chain.push(...parent);
      }
      chain.push(d.acl ?? undefined);
      const next = buildAclIndexFromChain(chain, nowMs);
      if (indexEqual(next, d.acl_index)) continue;
      if (await write("documents", d.id, next)) counts.documents += 1;
    }

    // Document sets carry their own visibility/acl_index and are RLS-gated on
    // it directly (document_sets_acl_select, 20260813), so a stale or expired
    // set index is exactly as fail-open as a document's. Chain: library → set.
    for (const s of setRows) {
      const lib = libById.get(s.library_id);
      if (!lib) { note(`document_sets ${s.id}: dangling library ${s.library_id} — skipped`); continue; }
      const next = buildAclIndexFromChain([lib.acl ?? undefined, s.acl ?? undefined], nowMs);
      if (indexEqual(next, s.acl_index)) continue;
      if (await write("document_sets", s.id, next)) counts.sets += 1;
    }
  }

  return counts;
}
