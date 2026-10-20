// lib/areaEquipmentProposals.ts — AREA-4 limbs 2-3 (intelligence Round G
// I-26): the Operating Areas checklist's "populate this area's equipment from
// its drawings" step. How many equipment tags the Equipment Bridge proposed
// off the area's drawings are still waiting for a person, and in which
// doc-control libraries — so the step can launch the sweep for that library
// in place (components/documents/EquipmentSweepModal.tsx), without a visit
// to /documents/[libraryId].
//
// The area's drawings are its knowledge shelf's mirrors (knowledge_documents
// with a source_document_id, on the area's bound library) — exactly the
// documents the source sync pulled in from the watched folders and
// libraries, never another unit's sheets beside them in the same library.
// The libraries offered for the sweep are the watched sources' own (a
// library source, a folder source's library) plus those the mirrors' source
// documents sit in, so the sweep can be opened (and auto-apply opted in) even
// before the first proposal exists.
//
// A pending proposal is a tag on a 'pending' document_equipment_suggestions
// row that the Bridge's apply would act on without being named: not applied,
// not dismissed, not held (lib/equipmentBridgeServer.ts applyForDocument's
// own rule — BR-5 / BR-9 / BR-13).
//
// Every read is the caller's own (RLS); nothing is written. Any read that
// fails answers null: the step says "not counted", never "0 waiting".

import { supabase } from "@/lib/supabase";

export interface AreaProposalLibrary {
  libraryId: string;
  libraryName: string;
  /** Area drawings in this library with at least one tag waiting. */
  documents: number;
  /** Tags waiting on those drawings. */
  tags: number;
}

export interface AreaProposals {
  /** The area's drawings (its shelf's mirrors of doc-control documents). */
  shelfDocuments: number;
  documents: number;
  tags: number;
  /** Most waiting first; libraries with nothing waiting last, by name. */
  libraries: AreaProposalLibrary[];
}

export interface SuggestionLedgerRow {
  document_id: string;
  status?: string | null;
  suggested?: unknown;
  applied?: unknown;
  dismissed?: unknown;
}

/** Pure: the tags on one ledger row the Bridge's apply would act on unnamed —
 *  a 'pending' row's suggestions not applied, not dismissed, not held. */
export function pendingTagsOf(row: SuggestionLedgerRow): string[] {
  if (row.status !== "pending" || !Array.isArray(row.suggested)) return [];
  const applied = new Set(Array.isArray(row.applied) ? (row.applied as unknown[]).map(String) : []);
  const dismissed = new Set(
    Array.isArray(row.dismissed)
      ? (row.dismissed as Array<{ tag?: unknown } | null>).filter((d) => d && typeof d.tag === "string").map((d) => String(d!.tag))
      : [],
  );
  const out: string[] = [];
  for (const s of row.suggested as Array<{ tag?: unknown; dismissed?: unknown; held?: unknown } | null>) {
    if (!s || typeof s.tag !== "string") continue;
    if (applied.has(s.tag) || dismissed.has(s.tag) || s.dismissed || s.held) continue;
    if (!out.includes(s.tag)) out.push(s.tag);
  }
  return out;
}

const PAGE = 1000;
const CHUNK = 200;
const columnMissing = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "42703" || e.code === "PGRST204" || /column [\w."]+ does not exist|could not find the .* column/i.test(e.message ?? ""));

class Unread extends Error {}

export async function countAreaEquipmentProposals(input: {
  orgId: string;
  knowledgeLibraryId: string;
  sources: ReadonlyArray<{ type: "library" | "folder"; sourceId: string }>;
}): Promise<AreaProposals | null> {
  const { orgId, knowledgeLibraryId, sources } = input;
  try {
    // The area's drawings: its shelf's mirrors, keyset-paged to an EMPTY page.
    const seen = new Set<string>();
    for (let after: string | null = null; ;) {
      let q = supabase.from("knowledge_documents").select("id, source_document_id")
        .eq("org_id", orgId).eq("library_id", knowledgeLibraryId).not("source_document_id", "is", null)
        .order("id", { ascending: true }).limit(PAGE);
      if (after) q = q.gt("id", after);
      const { data, error } = await q;
      if (error) throw new Unread(error.message);
      const batch = (data ?? []) as Array<{ id: string; source_document_id: string | null }>;
      if (batch.length === 0) break;
      for (const k of batch) if (k.source_document_id) seen.add(k.source_document_id);
      after = batch[batch.length - 1].id;
    }

    const sourceDocIds = [...seen];

    // The watched sources' libraries.
    const libs = new Map<string, { documents: number; tags: number }>();
    const touch = (id: string | null | undefined) => { if (id && !libs.has(id)) libs.set(id, { documents: 0, tags: 0 }); };
    for (const s of sources) if (s.type === "library") touch(s.sourceId);
    const folderIds = sources.filter((s) => s.type === "folder").map((s) => s.sourceId);
    for (let i = 0; i < folderIds.length; i += CHUNK) {
      const { data, error } = await supabase.from("collections").select("id, library_id").in("id", folderIds.slice(i, i + CHUNK));
      if (error) throw new Unread(error.message);
      for (const c of (data ?? []) as Array<{ library_id: string | null }>) touch(c.library_id);
    }

    // Each drawing's library and its ledger row.
    let shelfDocuments = 0;
    let withDismissed = true;
    for (let i = 0; i < sourceDocIds.length; i += CHUNK) {
      const slice = sourceDocIds.slice(i, i + CHUNK);
      const { data: docs, error: docErr } = await supabase.from("documents").select("id, library_id")
        .eq("org_id", orgId).in("id", slice).neq("status", "Archived");
      if (docErr) throw new Unread(docErr.message);
      const libOf = new Map<string, string>();
      for (const d of (docs ?? []) as Array<{ id: string; library_id: string | null }>) {
        if (!d.library_id) continue;
        libOf.set(d.id, d.library_id);
        touch(d.library_id);
      }
      shelfDocuments += libOf.size;
      if (libOf.size === 0) continue;
      const read = (cols: string) => supabase.from("document_equipment_suggestions").select(cols)
        .eq("org_id", orgId).eq("status", "pending").in("document_id", [...libOf.keys()]);
      let res = await read(withDismissed ? "document_id, status, suggested, applied, dismissed" : "document_id, status, suggested, applied");
      if (res.error && withDismissed && columnMissing(res.error)) {
        // Before 20261171 there is no dismissed column: a suggestion's own
        // `dismissed` flag still holds it back.
        withDismissed = false;
        res = await read("document_id, status, suggested, applied");
      }
      if (res.error) throw new Unread(res.error.message);
      for (const row of (res.data ?? []) as unknown as SuggestionLedgerRow[]) {
        const tags = pendingTagsOf(row).length;
        const lib = libOf.get(row.document_id);
        if (!tags || !lib) continue;
        const l = libs.get(lib)!;
        l.documents += 1;
        l.tags += tags;
      }
    }

    // Names, under the caller's RLS (a library they cannot read is not offered).
    const ids = [...libs.keys()];
    const names = new Map<string, string>();
    for (let i = 0; i < ids.length; i += CHUNK) {
      const { data, error } = await supabase.from("libraries").select("id, name").in("id", ids.slice(i, i + CHUNK));
      if (error) throw new Unread(error.message);
      for (const l of (data ?? []) as Array<{ id: string; name: string | null }>) names.set(l.id, l.name || "Untitled library");
    }
    const libraries: AreaProposalLibrary[] = ids.filter((id) => names.has(id))
      .map((id) => ({ libraryId: id, libraryName: names.get(id)!, ...libs.get(id)! }))
      .sort((a, b) => b.tags - a.tags || a.libraryName.localeCompare(b.libraryName));
    return {
      shelfDocuments,
      documents: libraries.reduce((n, l) => n + l.documents, 0),
      tags: libraries.reduce((n, l) => n + l.tags, 0),
      libraries,
    };
  } catch {
    return null;
  }
}
