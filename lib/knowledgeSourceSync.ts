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

export interface SourceSyncSummary {
  added: number;
  refreshed: number;
  removed: number;
  errors: string[];
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

/** One full reconcile pass for one knowledge library. Safe to re-run. */
export async function syncKnowledgeLibrarySources(libraryId: string): Promise<SourceSyncSummary> {
  const out: SourceSyncSummary = { added: 0, refreshed: 0, removed: 0, errors: [] };

  const { data: sourceRows, error: srcErr } = await supabaseAdmin
    .from("knowledge_sources")
    .select("id, org_id, library_id, source_type, source_id")
    .eq("library_id", libraryId);
  if (srcErr) {
    out.errors.push(`sources: ${srcErr.message}`);
    return out;
  }
  const sources = (sourceRows ?? []) as SourceRow[];
  if (sources.length === 0) return out;
  const orgId = sources[0].org_id;

  const landscape = await loadDcLandscape(orgId);

  // ── The per-document AI carve-out ────────────────────────────────────────
  // Linking a library says "the AI may read this container". A single file
  // inside it can still be held back — index the library, exclude the one
  // confidential report. Enforced HERE, at the only door into the knowledge
  // side, so an excluded document is never mirrored, chunked, or retrievable.
  const aiExcluded = new Set<string>();
  {
    const { data, error } = await supabaseAdmin
      .from("documents").select("id").eq("org_id", orgId).eq("ai_excluded", true);
    if (!error) for (const r of (data ?? []) as Array<{ id: string }>) aiExcluded.add(r.id);
    // Column absent (pre-migration): nothing is excluded, which matches the
    // behaviour before the feature existed.
  }

  // ── What SHOULD be mirrored: current PDFs in each source container ──────
  // Map dcDocId → { source, doc } (first source wins when containers overlap).
  const wanted = new Map<string, { sourceId: string; doc: DcDocRow }>();
  for (const source of sources) {
    let q = supabaseAdmin
      .from("documents")
      .select("id, name, title, document_number, status, archived_at, current_version_id")
      .eq("org_id", orgId);
    if (source.source_type === "library") {
      q = q.eq("library_id", source.source_id);
    } else {
      const subtree = [...folderSubtree(source.source_id, landscape)];
      if (subtree.length === 0) continue;
      q = q.in("collection_id", subtree);
    }
    const { data: docs, error } = await q;
    if (error) {
      out.errors.push(`enumerate ${source.source_id}: ${error.message}`);
      continue;
    }
    for (const d of (docs ?? []) as DcDocRow[]) {
      if (wanted.has(d.id)) continue;
      // ONE gate, shared with every other door (lib/aiBoundary.ts). Held
      // back, superseded, archived, or fileless — each is a different reason
      // and all four end here.
      const verdict = aiReadability({
        id: d.id, status: d.status, archivedAt: d.archived_at,
        currentVersionId: d.current_version_id, aiExcluded: aiExcluded.has(d.id),
      }, true);
      if (!verdict.readable) continue;
      wanted.set(d.id, { sourceId: source.id, doc: d });
    }
  }

  // Current version files for everything wanted.
  const versionIds = [...wanted.values()].map((w) => w.doc.current_version_id as string);
  const versionById = new Map<string, { file_url: string | null; file_type: string | null; revision_label: string | null; size: number | null }>();
  for (let i = 0; i < versionIds.length; i += 100) {
    const { data } = await supabaseAdmin
      .from("document_versions")
      .select("id, file_url, file_type, revision_label, size")
      .in("id", versionIds.slice(i, i + 100));
    for (const v of data ?? []) {
      versionById.set(v.id as string, {
        file_url: (v.file_url as string | null) ?? null,
        file_type: (v.file_type as string | null) ?? null,
        revision_label: (v.revision_label as string | null) ?? null,
        size: (v.size as number | null) ?? null,
      });
    }
  }

  // ── What IS mirrored right now ──────────────────────────────────────────
  const { data: existingRows, error: exErr } = await supabaseAdmin
    .from("knowledge_documents")
    .select("id, source_id, source_document_id, source_version_id")
    .eq("library_id", libraryId)
    .not("source_document_id", "is", null);
  if (exErr) {
    out.errors.push(`existing: ${exErr.message}`);
    return out;
  }
  const existingByDcDoc = new Map(
    (existingRows ?? []).map((r) => [r.source_document_id as string, r]),
  );

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
      if (existing) {
        await supabaseAdmin.from("knowledge_documents").delete().eq("id", existing.id as string);
        existingByDcDoc.delete(dcDocId);
        out.removed++;
      }
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
      });
    } else if (existing.source_version_id !== doc.current_version_id) {
      // Rev published: drop the old index and queue a re-ingest of the new
      // file. The knowledge doc id is stable so past citations keep linking.
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
      }).eq("id", existing.id as string);
      if (error) out.errors.push(`refresh ${displayName(doc)}: ${error.message}`);
      else out.refreshed++;
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
  for (const [dcDocId, row] of existingByDcDoc) {
    if (wanted.has(dcDocId)) continue;
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
