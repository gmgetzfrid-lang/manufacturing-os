// lib/knowledgeSourceSync.ts — SERVER-ONLY. Keeps a knowledge library's
// mirrored documents in lockstep with its document-control sources.
//
// A source (whole DC library or a folder subtree) is a LIVE subscription.
// One sync pass per library:
//
//   ADD     a controlled PDF filed into a source container → a pending
//           knowledge_documents row pointing at the SAME R2 object (no copy)
//   REFRESH a linked doc whose current version changed (rev-up) → chunks
//           dropped, counters reset, status 'stale' → the indexer re-ingests
//           so answers only ever cite the CURRENT revision
//   REMOVE  a linked doc that left the container, lost its PDF, or was
//           archived/superseded/voided → row deleted (chunks cascade)
//
// Called from the sources API (immediately after linking, and on demand)
// and from the maintenance cron (the background heartbeat).

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadDcLandscape, folderSubtree } from "@/lib/knowledgeAccess";
import { aiReadability } from "@/lib/aiBoundary";
import { fetchAllRows } from "@/lib/fetchAllRows";

export interface SourceSyncSummary {
  added: number;
  refreshed: number;
  removed: number;
  /** Index work set aside (kept, not searchable) instead of deleted. */
  retired: number;
  /** Retired index work brought back instead of re-reading the file. */
  restored: number;
  /** Renamed or re-labelled in the document library — name updated, nothing re-read. */
  renamed: number;
  errors: string[];
}

/** Retire = keep a mirror's pages, tags and meaning index, but take it out
 *  of every search (the search functions only read ready/indexing). Needs
 *  20261024_knowledge_retire.sql; on an older database it reports false and
 *  the caller falls back to deleting, as before. */
async function retireMirror(id: string, reason: string): Promise<boolean> {
  const { error } = await supabaseAdmin.from("knowledge_documents")
    .update({ status: "retired", retired_at: new Date().toISOString(), retired_reason: reason.slice(0, 200) })
    .eq("id", id);
  return !error;
}

type SourceRow = {
  id: string;
  org_id: string;
  library_id: string;
  source_type: "library" | "folder";
  source_id: string;
};

type DcDocRow = {
  id: string;
  name: string | null;
  title: string | null;
  document_number: string | null;
  status: string | null;
  archived_at: string | null;
  current_version_id: string | null;
};

const displayName = (d: DcDocRow): string => {
  const number = (d.document_number ?? "").trim();
  const title = (d.title ?? d.name ?? "").trim();
  if (number && title && number !== title) return `${number} — ${title}`;
  return title || number || "Document";
};

const isPdf = (fileUrl: string | null, fileType: string | null): boolean => {
  if ((fileType ?? "").toLowerCase().includes("pdf")) return true;
  return (fileUrl ?? "").toLowerCase().endsWith(".pdf");
};

/** Every document in a knowledge library's linked sources, each with the
 *  AI-readability verdict, plus what SHOULD be mirrored. Shared by the sync
 *  and the health check so the two can never disagree about what belongs. */
export interface PlannedDoc {
  sourceId: string;
  doc: DcDocRow;
  blocked: "held_back" | "out_of_scope" | "not_current" | "no_file" | null;
}
export interface SourcePlan {
  orgId: string;
  sources: Array<SourceRow & { source_name: string | null }>;
  landscape: Awaited<ReturnType<typeof loadDcLandscape>>;
  all: PlannedDoc[];
  wanted: Map<string, { sourceId: string; doc: DcDocRow }>;
  retiredReason: Map<string, string>;
  versionById: Map<string, { file_url: string | null; file_type: string | null; revision_label: string | null; size: number | null; file_hash?: string | null }>;
  /** Sources skipped because their library is marked never-AI. */
  neverAiSources: string[];
  incomplete: boolean;
  errors: string[];
}

export async function planKnowledgeSources(libraryId: string, healNames = false): Promise<SourcePlan | null> {
  const errors: string[] = [];
  const { data: sourceRows, error: srcErr } = await supabaseAdmin
    .from("knowledge_sources")
    .select("id, org_id, library_id, source_type, source_id, source_name")
    .eq("library_id", libraryId);
  if (srcErr) {
    errors.push(`sources: ${srcErr.message}`);
    return null;
  }
  const sources = (sourceRows ?? []) as Array<SourceRow & { source_name: string | null }>;
  if (sources.length === 0) return null;
  const orgId = sources[0].org_id;

  const landscape = await loadDcLandscape(orgId);
  // Any read below that comes back short or errors makes this pass
  // INCOMPLETE — and an incomplete pass adds and refreshes, but never
  // removes. "I didn't see it" must never be taken as "it's gone".
  let incomplete = !landscape.complete;

  // ── Self-heal display names ─────────────────────────────────────────────
  // source_name is a denormalized snapshot from link time; matching is by id
  // so a renamed/moved DC folder keeps working — but its label would lie
  // forever. Every sync pass recomputes the same "Library / Folder / Sub"
  // path the link API writes and updates any that drifted. Best-effort: a
  // failed label write must never block the document reconcile below.
  for (const source of healNames ? sources : []) {
    let fresh: string | null = null;
    if (source.source_type === "library") {
      fresh = landscape.libraries.get(source.source_id)?.name ?? null;
    } else {
      const f = landscape.folders.get(source.source_id);
      if (f) {
        const lib = landscape.libraries.get(f.library_id)?.name ?? "Library";
        fresh = [lib, ...(f.path_names.length ? f.path_names : [f.name])].join(" / ");
      }
    }
    // A vanished container keeps its last-known name — that's exactly what
    // the dead-source drift warning shows the user.
    if (fresh && fresh !== source.source_name) {
      await supabaseAdmin.from("knowledge_sources")
        .update({ source_name: fresh }).eq("id", source.id)
        .then(() => undefined, () => undefined);
    }
  }

  // ── The per-document AI carve-out ────────────────────────────────────────
  // Linking a library says "the AI may read this container". A single file
  // inside it can still be held back — index the library, exclude the one
  // confidential report. Enforced HERE, at the only door into the knowledge
  // side, so an excluded document is never mirrored, chunked, or retrievable.
  const aiExcluded = new Set<string>();
  {
    const { rows, error } = await fetchAllRows<{ id: string }>((from, to) => supabaseAdmin
      .from("documents").select("id").eq("org_id", orgId).eq("ai_excluded", true).order("id").range(from, to));
    if (!error) for (const r of rows) aiExcluded.add(r.id);
    // Column absent (pre-migration): nothing is excluded, which matches the
    // behaviour before the feature existed.
  }

  // ── Whole libraries marked never-AI: nothing in them is mirrored, and
  //    a mirror that exists is removed below like any unwanted one.
  const { excludedLibraryIds } = await import("@/lib/aiLibraries");
  const neverAi = await excludedLibraryIds(supabaseAdmin, orgId);
  const libraryOfDoc = (d: { library_id?: string | null; collection_id?: string | null }) =>
    (d.library_id as string | null | undefined) ?? (d.collection_id ? landscape.folders.get(d.collection_id)?.library_id ?? null : null);

  // ── What SHOULD be mirrored: current PDFs in each source container ──────
  // Map dcDocId → { source, doc } (first source wins when containers overlap).
  const wanted = new Map<string, { sourceId: string; doc: DcDocRow }>();
  const retiredReason = new Map<string, string>();
  const all: PlannedDoc[] = [];
  const seenDocs = new Set<string>();
  const neverAiSources: string[] = [];
  const DOC_COLS = "id, name, title, document_number, status, archived_at, current_version_id, library_id, collection_id";
  for (const source of sources) {
    const sourceLib = source.source_type === "library" ? source.source_id : landscape.folders.get(source.source_id)?.library_id ?? null;
    if (sourceLib && neverAi.has(sourceLib)) { neverAiSources.push(source.id); continue; }
    const enumerated: DcDocRow[] = [];
    // Every page, not the first 1,000 — that cap is why a big linked
    // library showed "1k indexed" and the rest never arrived.
    const readAll = async (label: string, build: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>) => {
      const { rows, error } = await fetchAllRows<DcDocRow>(build);
      enumerated.push(...rows);
      if (error) { errors.push(`enumerate ${label}: ${error}`); incomplete = true; }
    };
    if (source.source_type === "library") {
      await readAll(source.source_id, (from, to) => supabaseAdmin.from("documents").select(DOC_COLS)
        .eq("org_id", orgId).eq("library_id", source.source_id).order("id").range(from, to));
      // documents.library_id is nullable: a doc filed into one of this
      // library's FOLDERS with a null library_id belongs to the library
      // all the same, and skipping it here would leave it "pending sync"
      // forever in every picker that uses the same coverage rule.
      const folderIds = [...landscape.folders.entries()]
        .filter(([, f]) => f.library_id === source.source_id)
        .map(([id]) => id);
      for (let i = 0; i < folderIds.length; i += 100) {
        const chunk = folderIds.slice(i, i + 100);
        await readAll(`${source.source_id} folders`, (from, to) => supabaseAdmin.from("documents").select(DOC_COLS)
          .eq("org_id", orgId).is("library_id", null).in("collection_id", chunk).order("id").range(from, to));
      }
    } else {
      const subtree = [...folderSubtree(source.source_id, landscape)];
      if (subtree.length === 0) continue;
      // In slices: a big folder tree's ids don't fit in one request URL.
      for (let i = 0; i < subtree.length; i += 100) {
        const chunk = subtree.slice(i, i + 100);
        await readAll(source.source_id, (from, to) => supabaseAdmin.from("documents").select(DOC_COLS)
          .eq("org_id", orgId).in("collection_id", chunk).order("id").range(from, to));
      }
    }
    for (const d of enumerated) {
      if (wanted.has(d.id) || seenDocs.has(d.id)) continue;
      seenDocs.add(d.id);
      const lib = libraryOfDoc(d as { library_id?: string | null; collection_id?: string | null });
      if (lib && neverAi.has(lib)) continue;
      // ONE gate, shared with every other door (lib/aiBoundary.ts). Held
      // back, superseded, archived, or fileless — each is a different reason
      // and all four end here.
      const verdict = aiReadability({
        id: d.id, status: d.status, archivedAt: d.archived_at,
        currentVersionId: d.current_version_id, aiExcluded: aiExcluded.has(d.id),
      }, true);
      all.push({ sourceId: source.id, doc: d, blocked: verdict.readable ? null : (verdict.reason as "held_back" | "out_of_scope" | "not_current" | "no_file") });
      if (!verdict.readable) { retiredReason.set(d.id, verdict.reason ?? "not readable"); continue; }
      wanted.set(d.id, { sourceId: source.id, doc: d });
    }
  }

  // Current version files for everything wanted.
  const versionIds = [...wanted.values()].map((w) => w.doc.current_version_id as string);
  const versionById = new Map<string, { file_url: string | null; file_type: string | null; revision_label: string | null; size: number | null; file_hash?: string | null }>();
  for (let i = 0; i < versionIds.length; i += 100) {
    const { data } = await supabaseAdmin
      .from("document_versions")
      .select("id, file_url, file_type, revision_label, size, file_hash")
      .in("id", versionIds.slice(i, i + 100));
    for (const v of data ?? []) {
      versionById.set(v.id as string, {
        file_url: (v.file_url as string | null) ?? null,
        file_type: (v.file_type as string | null) ?? null,
        revision_label: (v.revision_label as string | null) ?? null,
        size: (v.size as number | null) ?? null,
        file_hash: (v.file_hash as string | null) ?? null,
      });
    }
  }


  return { orgId, sources, landscape, all, wanted, retiredReason, versionById, neverAiSources, incomplete, errors };
}

/** One full reconcile pass for one knowledge library. Safe to re-run. */
export async function syncKnowledgeLibrarySources(libraryId: string): Promise<SourceSyncSummary> {
  const out: SourceSyncSummary = { added: 0, refreshed: 0, removed: 0, retired: 0, restored: 0, renamed: 0, errors: [] };

  const plan = await planKnowledgeSources(libraryId, true);
  if (!plan) return out;
  const { orgId, wanted, retiredReason, versionById } = plan;
  out.errors.push(...plan.errors);
  const incomplete = plan.incomplete;

  // ── What IS mirrored right now ──────────────────────────────────────────
  const { rows: existingRows, error: exErr } = await fetchAllRows<Record<string, unknown>>((from, to) => supabaseAdmin
    .from("knowledge_documents")
    // "*", not named columns: a database without the newest columns
    // (file_hash, retired_at…) must still sync.
    .select("*")
    .eq("library_id", libraryId)
    .not("source_document_id", "is", null)
    .order("id").range(from, to));
  if (exErr) {
    out.errors.push(`existing: ${exErr}`);
    return out;
  }
  const existingByDcDoc = new Map(
    (existingRows ?? []).map((r) => [r.source_document_id as string, r]),
  );

  // ── RESTORE retired index work before reading anything again ───────────
  // A document that left a source (moved out, held back, archived) had its
  // index RETIRED, not deleted. When it's wanted again — moved back, moved
  // into a folder another knowledge library watches, re-included — its
  // pages, tags and meaning index come back as they were. Nothing is paid
  // for twice.
  {
    const needs: string[] = [];
    for (const dcDocId of wanted.keys()) {
      const ex = existingByDcDoc.get(dcDocId);
      if (!ex || ex.status === "retired") needs.push(dcDocId);
    }
    for (let i = 0; i < needs.length; i += 100) {
      const { data: parked, error: pErr } = await supabaseAdmin.from("knowledge_documents")
        .select("id, library_id, source_document_id, source_version_id, pages_indexed, page_count, retired_at")
        .eq("org_id", orgId).eq("status", "retired").in("source_document_id", needs.slice(i, i + 100))
        .order("retired_at", { ascending: false });
      if (pErr) break; // pre-migration: nothing is ever retired
      type Parked = { id: string; library_id: string; source_document_id: string; source_version_id: string | null; pages_indexed: number; page_count: number | null };
      // One copy per document: the one already in THIS library if there is
      // one (a library holds at most one entry per document), else the newest.
      const pick = new Map<string, Parked>();
      for (const r of (parked ?? []) as Parked[]) {
        const cur = pick.get(r.source_document_id);
        if (!cur || (r.library_id === libraryId && cur.library_id !== libraryId)) pick.set(r.source_document_id, r);
      }
      for (const r of pick.values()) {
        // This library already holds a different entry for it (the pick
        // above prefers this library's own copy, so this one is live): the
        // copy elsewhere stays parked.
        const here = existingByDcDoc.get(r.source_document_id);
        if (here && here.id !== r.id) continue;
        const w = wanted.get(r.source_document_id)!;
        const complete = (r.page_count ?? 0) > 0 && r.pages_indexed >= (r.page_count ?? 0);
        if (r.library_id !== libraryId) {
          // Moved between knowledge libraries: its rows follow it.
          await supabaseAdmin.from("knowledge_chunks").update({ library_id: libraryId }).eq("document_id", r.id);
          await supabaseAdmin.from("knowledge_page_entities").update({ library_id: libraryId }).eq("document_id", r.id)
            .then(() => undefined, () => undefined);
        }
        const { error: uErr } = await supabaseAdmin.from("knowledge_documents").update({
          library_id: libraryId, source_id: w.sourceId, status: complete ? "ready" : "pending",
          retired_at: null, retired_reason: null, error: null,
        }).eq("id", r.id);
        if (uErr) { out.errors.push(`restore: ${uErr.message}`); continue; }
        existingByDcDoc.set(r.source_document_id, { id: r.id, source_id: w.sourceId, source_document_id: r.source_document_id, source_version_id: r.source_version_id, status: complete ? "ready" : "pending" });
        out.restored++;
      }
    }
  }

  // ── ADD + REFRESH ───────────────────────────────────────────────────────
  // Inserts are BATCHED (100 rows/call): a big library linked in one go must
  // finish well inside serverless time limits (Vercel Hobby kills at 60s —
  // row-at-a-time inserts were the old 504).
  const toInsert: Array<Record<string, unknown>> = [];
  for (const [dcDocId, { sourceId, doc }] of wanted) {
    const version = versionById.get(doc.current_version_id as string);
    if (!version?.file_url || !isPdf(version.file_url, version.file_type)) {
      // Not an ingestable PDF (native CAD, image, missing file): if a stale
      // mirror exists from an older PDF revision, drop it — answers must not
      // cite a superseded file.
      const existing = existingByDcDoc.get(dcDocId);
      if (existing && existing.status !== "retired") {
        if (await retireMirror(existing.id as string, "current revision isn't a readable PDF")) out.retired++;
        else {
          await supabaseAdmin.from("knowledge_documents").delete().eq("id", existing.id as string);
          out.removed++;
        }
      }
      if (existing) existingByDcDoc.delete(dcDocId);
      continue;
    }

    const existing = existingByDcDoc.get(dcDocId);
    if (!existing) {
      toInsert.push({
        org_id: orgId,
        library_id: libraryId,
        name: displayName(doc),
        file_key: version.file_url,
        file_size: version.size,
        status: "pending",
        source_id: sourceId,
        source_document_id: dcDocId,
        source_version_id: doc.current_version_id,
        source_rev: version.revision_label,
        // The bytes' identity: what was read for them anywhere is reused.
        file_hash: version.file_hash ?? null,
      });
    } else if (existing.source_version_id !== doc.current_version_id
      && version.file_hash && existing.file_hash && version.file_hash === existing.file_hash) {
      // New revision, SAME bytes (a revision letter bumped, the same PDF
      // re-issued): the index is still exactly right — keep it, just follow
      // the revision. Nothing is re-read, nothing re-embedded.
      const { error } = await supabaseAdmin.from("knowledge_documents").update({
        name: displayName(doc), source_id: sourceId, source_version_id: doc.current_version_id,
        source_rev: version.revision_label, file_key: version.file_url,
      }).eq("id", existing.id as string);
      if (error) out.errors.push(`follow revision ${displayName(doc)}: ${error.message}`);
      else out.refreshed++;
    } else if (existing.source_version_id !== doc.current_version_id) {
      // Rev published: drop the old index and queue a re-ingest of the new
      // file. The knowledge doc id is stable so past citations keep linking.
      // New bytes: every reading of the old ones goes, the drawing census
      // included, so the new revision is read fresh.
      await supabaseAdmin.from("knowledge_page_entities").delete().eq("document_id", existing.id as string).then(() => undefined, () => undefined);
      const { error: chunkErr } = await supabaseAdmin
        .from("knowledge_chunks").delete().eq("document_id", existing.id as string);
      if (chunkErr) {
        out.errors.push(`refresh ${displayName(doc)}: ${chunkErr.message}`);
        continue;
      }
      const { error } = await supabaseAdmin.from("knowledge_documents").update({
        name: displayName(doc),
        file_key: version.file_url,
        file_size: version.size,
        status: "stale",
        error: null,
        pages_indexed: 0,
        page_count: null,
        last_section: null,
        source_id: sourceId,
        source_version_id: doc.current_version_id,
        source_rev: version.revision_label,
        file_hash: version.file_hash ?? null,
      }).eq("id", existing.id as string);
      if (error) out.errors.push(`refresh ${displayName(doc)}: ${error.message}`);
      else out.refreshed++;
    } else if (existing.name !== displayName(doc) || (existing.source_rev ?? null) !== (version.revision_label ?? null)) {
      // Same file, new name or revision label (renamed in the document
      // library, or its name repaired): answers must cite it by its real
      // name. Only the label changes — nothing is re-read or re-embedded.
      const { error } = await supabaseAdmin.from("knowledge_documents").update({
        name: displayName(doc), source_rev: version.revision_label,
      }).eq("id", existing.id as string);
      if (error) out.errors.push(`rename ${displayName(doc)}: ${error.message}`);
      else out.renamed++;
    }
  }

  // Batched inserts; on a duplicate collision (concurrent sync) fall back to
  // row-at-a-time for that batch, treating 23505 as already-mirrored.
  for (let i = 0; i < toInsert.length; i += 100) {
    const batch = toInsert.slice(i, i + 100);
    const { error } = await supabaseAdmin.from("knowledge_documents").insert(batch);
    if (!error) {
      out.added += batch.length;
      continue;
    }
    if (error.code !== "23505") {
      out.errors.push(`add batch: ${error.message}`);
      continue;
    }
    for (const row of batch) {
      const { error: rowErr } = await supabaseAdmin.from("knowledge_documents").insert(row);
      if (!rowErr) out.added++;
      else if (rowErr.code !== "23505") out.errors.push(`add ${row.name as string}: ${rowErr.message}`);
    }
  }

  // ── REMOVE mirrors whose controlled doc left the sources ────────────────
  // Only on a COMPLETE pass. A partial read used to compare two different
  // 1,000-row samples and delete the index of documents that were simply
  // past the cutoff — then re-add them on a later pass.
  if (incomplete) {
    out.errors.push("Removal skipped this pass: not every document could be read. Nothing was removed.");
    return out;
  }
  for (const [dcDocId, row] of existingByDcDoc) {
    if (wanted.has(dcDocId) || row.status === "retired") continue;
    // Set aside, not destroyed: if this document comes back, its index does
    // too. Retired copies are invisible to every search.
    if (await retireMirror(row.id as string, retiredReason.get(dcDocId) ?? "left the linked sources")) {
      out.retired++;
      continue;
    }
    const { error } = await supabaseAdmin
      .from("knowledge_documents").delete().eq("id", row.id as string);
    if (error) out.errors.push(`remove: ${error.message}`);
    else out.removed++;
  }

  return out;
}

/** Cron entry: sync every knowledge library that has sources (bounded). */
export async function syncAllKnowledgeSources(maxLibraries = 25): Promise<{
  libraries: number; added: number; refreshed: number; removed: number; errors: string[];
}> {
  const out = { libraries: 0, added: 0, refreshed: 0, removed: 0, errors: [] as string[] };
  const { data, error } = await supabaseAdmin
    .from("knowledge_sources").select("library_id");
  if (error) {
    // Pre-migration DB — nothing to sync yet.
    return out;
  }
  const libraryIds = [...new Set((data ?? []).map((r) => r.library_id as string))].slice(0, maxLibraries);
  for (const libraryId of libraryIds) {
    const res = await syncKnowledgeLibrarySources(libraryId);
    out.libraries++;
    out.added += res.added;
    out.refreshed += res.refreshed;
    out.removed += res.removed;
    out.errors.push(...res.errors);
  }
  return out;
}
