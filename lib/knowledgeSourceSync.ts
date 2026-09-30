// lib/knowledgeSourceSync.ts — SERVER-ONLY. Keeps a knowledge library's
// mirrored documents in lockstep with its document-control sources.
//
// A source (whole DC library or a folder subtree) is a LIVE subscription.
// One sync pass per library:
//
//   ADD     a controlled PDF filed into a source container → a pending
//           knowledge_documents row pointing at the SAME R2 object (no copy)
//   REFRESH a linked doc whose current version changed (rev-up) → the
//           whole derived index dropped (chunks, page entities, machine
//           mentions, cached traces — lib/knowledgeIngest.ts
//           resetKnowledgeIndex), counters reset, status 'stale' → the
//           indexer re-ingests so answers only ever cite the CURRENT revision
//   REMOVE  a linked doc that left the container, lost its PDF, or was
//           archived/superseded/voided → row deleted (chunks cascade)
//
// Called from the sources API (immediately after linking, and on demand)
// and from the maintenance cron (the background heartbeat).

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadDcLandscape, folderSubtree } from "@/lib/knowledgeAccess";
import { aiReadability } from "@/lib/aiBoundary";
import { resetKnowledgeIndex, isMissingColumn } from "@/lib/knowledgeIngest";

export interface SourceSyncSummary {
  added: number;
  refreshed: number;
  removed: number;
  /** Rev-ups this pass could not land: another sync re-pointed the mirror
   *  first. A rev-up that finds a batch still writing the OLD revision is
   *  NOT deferred — it re-points the row, and that batch's compare-and-set
   *  misses and withdraws what it wrote (ING-1). A library with a deferred
   *  or failed refresh is left never-synced, so the next run reaches it
   *  first. */
  deferred: number;
  /** Sources whose document-control container no longer exists (IRLS-7):
   *  their mirrors are removed below; the source row itself is reported. */
  danglingSources: number;
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
  const out: SourceSyncSummary = { added: 0, refreshed: 0, removed: 0, deferred: 0, danglingSources: 0, errors: [] };

  const { data: sourceRows, error: srcErr } = await supabaseAdmin
    .from("knowledge_sources")
    .select("id, org_id, library_id, source_type, source_id, source_name")
    .eq("library_id", libraryId);
  if (srcErr) {
    out.errors.push(`sources: ${srcErr.message}`);
    return out;
  }
  const sources = (sourceRows ?? []) as Array<SourceRow & { source_name: string | null }>;
  if (sources.length === 0) return out;
  const orgId = sources[0].org_id;

  const landscape = await loadDcLandscape(orgId);

  // ── Self-heal display names ─────────────────────────────────────────────
  // source_name is a denormalized snapshot from link time; matching is by id
  // so a renamed/moved DC folder keeps working — but its label would lie
  // forever. Every sync pass recomputes the same "Library / Folder / Sub"
  // path the link API writes and updates any that drifted. Best-effort: a
  // failed label write must never block the document reconcile below.
  for (const source of sources) {
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
    // …and the scheduled pass says so too (IRLS-7): source_id is a
    // polymorphic pointer the database cannot enforce, so a deleted library
    // or folder leaves this row dangling. Its mirrors fall out of `wanted`
    // and are removed below; the row is reported for a person to unlink.
    // Only when the landscape loaded at all — an empty read is not proof.
    if (!fresh && (landscape.libraries.size > 0 || landscape.folders.size > 0)) {
      out.danglingSources++;
      out.errors.push(`dangling source "${source.source_name ?? source.source_id}": its document-control ${source.source_type} no longer exists — unlink it from this library`);
    }
  }

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
    const enumerated: DcDocRow[] = [...((docs ?? []) as DcDocRow[])];
    if (source.source_type === "library") {
      // documents.library_id is nullable: a doc filed into one of this
      // library's FOLDERS with a null library_id belongs to the library
      // all the same, and skipping it here would leave it "pending sync"
      // forever in every picker that uses the same coverage rule.
      const folderIds = [...landscape.folders.entries()]
        .filter(([, f]) => f.library_id === source.source_id)
        .map(([id]) => id);
      for (let i = 0; i < folderIds.length; i += 100) {
        const { data: extra, error: exErr } = await supabaseAdmin
          .from("documents")
          .select("id, name, title, document_number, status, archived_at, current_version_id")
          .eq("org_id", orgId).is("library_id", null)
          .in("collection_id", folderIds.slice(i, i + 100));
        if (exErr) {
          out.errors.push(`enumerate ${source.source_id} folders: ${exErr.message}`);
          continue;
        }
        enumerated.push(...((extra ?? []) as DcDocRow[]));
      }
    }
    for (const d of enumerated) {
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
  // A refresh that did not land (deferred, or failed before the row moved):
  // this library must come round again first, not last (ILIFE-13).
  let unsettled = false;
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
      // The WHOLE derived index goes (ING-3 / DWG-1): chunks, and the page
      // entities, machine mentions and cached traces the old revision's
      // sheets produced — before this, the tags of a superseded revision
      // stayed live under the new revision's label. The reset takes the
      // document's ingest claim; if a batch holds it, writing the OLD file,
      // the row is re-pointed anyway (`supersedeBusy`) — that batch's
      // compare-and-set then misses and withdraws what it wrote, so the
      // superseded revision is never completed to 'ready' (ING-1).
      const res = await resetKnowledgeIndex([existing.id as string], {
        purgeLineTraces: true,
        supersedeBusy: true,
        rowUpdate: () => ({
          name: displayName(doc),
          file_key: version.file_url,
          file_size: version.size,
          source_id: sourceId,
          source_version_id: doc.current_version_id,
          source_rev: version.revision_label,
        }),
      });
      if (res.reset.length > 0) out.refreshed++;
      if (res.busy.length > 0) { out.deferred++; unsettled = true; }
      if (res.errors.length > 0) {
        out.errors.push(`refresh ${displayName(doc)}: ${res.errors.join("; ")}`);
        // A failure after the row moved is backstopped by the re-index; one
        // before it left the old version in place — come back first.
        if (res.reset.length === 0) unsettled = true;
      }
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

  // The rotation cursor (ILIFE-13): this library was reconciled now, by the
  // cron or on demand, so the heartbeat reaches the others first — unless a
  // rev-up here did not land, in which case it is marked never-synced and
  // the next run reaches it FIRST. A pre-20261122 database has no column;
  // the rotation then falls back to a daily offset (syncAllKnowledgeSources).
  {
    const { error } = await supabaseAdmin.from("knowledge_sources")
      .update({ last_synced_at: unsettled ? null : new Date().toISOString() }).eq("library_id", libraryId);
    if (error && !isMissingColumn(error)) out.errors.push(`last synced: ${error.message}`);
  }

  return out;
}

/** Cron entry: sync every knowledge library that has sources — oldest
 *  first, fair across orgs, bounded by time (ILIFE-13).
 *
 *  It used to take `.slice(0, 25)` of an unordered, unpaged read shared by
 *  every tenant: the same prefix every day, and a library past the cut never
 *  reconciled (no new documents, no rev-up, and — the lifecycle half — no
 *  REMOVE pass for documents deleted from doc control). Now every source row
 *  is read (paged past PostgREST's 1,000-row cap), each library is ordered by
 *  when it was last reconciled (never first), orgs are interleaved round-
 *  robin so one tenant's shelf count cannot starve another's, and the pass
 *  runs until its time budget. Every library is reached within
 *  ceil(libraries / per-run) runs; `unsynced` says how many wait for the next. */
export async function syncAllKnowledgeSources(
  opts: { maxLibraries?: number; deadlineMs?: number } | number = {},
): Promise<{
  libraries: number; added: number; refreshed: number; removed: number;
  deferred: number; unsynced: number; errors: string[];
}> {
  const o = typeof opts === "number" ? { maxLibraries: opts } : opts;
  const maxLibraries = o.maxLibraries ?? 500;
  const deadlineMs = o.deadlineMs ?? Date.now() + 45_000;
  const out = { libraries: 0, added: 0, refreshed: 0, removed: 0, deferred: 0, unsynced: 0, errors: [] as string[] };

  type SourceCursor = { library_id: string; org_id: string; last_synced_at?: string | null };
  const readAll = async (withCursor: boolean): Promise<{ rows: SourceCursor[]; error: { code?: string; message?: string } | null }> => {
    const rows: SourceCursor[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabaseAdmin
        .from("knowledge_sources")
        .select(withCursor ? "library_id, org_id, last_synced_at" : "library_id, org_id")
        .order("library_id", { ascending: true })
        .range(from, from + 999);
      if (error) return { rows, error };
      const page = (data ?? []) as unknown as SourceCursor[];
      rows.push(...page);
      if (page.length < 1000) return { rows, error: null };
    }
  };
  let { rows, error } = await readAll(true);
  const cursored = !error;
  if (error && isMissingColumn(error)) ({ rows, error } = await readAll(false));
  if (error) {
    // Pre-migration DB — nothing to sync yet.
    return out;
  }

  // One entry per library: its OLDEST source stamp (one never-synced source
  // makes the library never-synced).
  const byLibrary = new Map<string, { org: string; at: string }>();
  for (const r of rows) {
    const at = cursored ? (r.last_synced_at ?? "") : "";
    const prev = byLibrary.get(r.library_id);
    if (!prev || at < prev.at) byLibrary.set(r.library_id, { org: r.org_id, at });
  }
  let ordered = [...byLibrary.entries()]
    .sort((a, b) => (a[1].at < b[1].at ? -1 : a[1].at > b[1].at ? 1 : a[0].localeCompare(b[0])));
  if (!cursored && ordered.length > 0) {
    // No cursor column yet: rotate the start by the day so the same prefix
    // is not the only one ever reached.
    const shift = (Math.floor(Date.now() / 86_400_000) * 25) % ordered.length;
    ordered = [...ordered.slice(shift), ...ordered.slice(0, shift)];
  }
  // Round-robin across orgs, each org's libraries oldest-first.
  const perOrg = new Map<string, string[]>();
  for (const [libraryId, { org }] of ordered) {
    const list = perOrg.get(org) ?? [];
    list.push(libraryId);
    perOrg.set(org, list);
  }
  const queue: string[] = [];
  for (let round = 0; queue.length < ordered.length; round++) {
    for (const list of perOrg.values()) if (round < list.length) queue.push(list[round]);
  }

  for (const libraryId of queue) {
    if (out.libraries >= maxLibraries || Date.now() > deadlineMs) break;
    const res = await syncKnowledgeLibrarySources(libraryId);
    out.libraries++;
    out.added += res.added;
    out.refreshed += res.refreshed;
    out.removed += res.removed;
    out.deferred += res.deferred;
    out.errors.push(...res.errors);
  }
  out.unsynced = queue.length - out.libraries;
  return out;
}
