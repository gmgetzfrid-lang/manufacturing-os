// lib/knowledgeHealthServer.ts — SERVER-ONLY. The health report and the
// repair for one knowledge library.
//
// The report reconciles EVERY document in the linked sources against the
// library's index (see lib/knowledgeHealth.ts for the statuses), counts the
// uploaded PDFs, the retired entries and the meaning-index coverage.
//
// Repair fixes what is fixable, and never throws index work away:
//   1. a complete sync — adds what's missing, refreshes outdated revisions,
//      restores retired entries, retires leftovers (kept, not deleted)
//   2. re-queues failed, stuck and partly-read documents; reading resumes
//      from the last page done, and text already read is reused
// Reading and the meaning index then continue on the library's own queue.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchAllRows } from "@/lib/fetchAllRows";
import { inSlices } from "@/lib/inSlices";
import { planKnowledgeSources, syncKnowledgeLibrarySources, type SourceSyncSummary } from "@/lib/knowledgeSourceSync";
import { findNameFixes, repairDocumentNames, type NameRepairResult } from "@/lib/documentNameRepair";
import type { NameFix } from "@/lib/documentNames";
import { isBusyDbError } from "@/lib/knowledgeEmbedCore";
import { summarize, STUCK_AFTER_MS, type HealthSummary, type MirrorFacts, type SourceDocFacts } from "@/lib/knowledgeHealth";

interface MirrorRow {
  id: string; name: string; status: string; source_document_id: string | null; source_version_id: string | null;
  pages_indexed: number | null; page_count: number | null; error: string | null;
  updated_at?: string | null; created_at: string;
}

export interface KnowledgeHealthReport {
  checkedAt: string;
  libraryId: string;
  sources: Array<{ id: string; type: "library" | "folder"; name: string; exists: boolean; neverAi: boolean }>;
  /** Linked-source documents, each with one status. Null = no sources linked. */
  linked: HealthSummary | null;
  uploaded: { total: number; ready: number; waiting: number; failed: number; partial: number };
  retired: number;
  /** Null when the counts couldn't be read in time (heavy indexing) — not an error. */
  meaning: { chunks: number; embedded: number } | null;
  /** Linked documents whose number/revision the old filename reader got wrong. */
  names: { wrong: number; clashes: number; samples: NameFix[]; checked: boolean };
  /** A read failed part-way — the numbers may be short; Repair won't remove anything. */
  incomplete: boolean;
  /** Checks left out to answer in time (the database was slow) — run again. */
  skipped: string[];
  errors: string[];
}

async function count(build: () => PromiseLike<{ count: number | null; error: unknown }>): Promise<number | null> {
  try { const r = await build(); return r.error ? null : r.count ?? 0; } catch { return null; }
}

/** The report answers inside the host's 60-second limit, always: the core
 *  reconciliation runs first, and the extra checks (copies set aside
 *  elsewhere, document names, meaning-index counts) each run only while
 *  there's time left — any left out are named in `skipped`. */
export async function knowledgeHealthReport(orgId: string, libraryId: string, budgetMs = 40_000): Promise<KnowledgeHealthReport> {
  const now = Date.now();
  const timeLeft = () => budgetMs - (Date.now() - now);
  const errors: string[] = [];
  const skipped: string[] = [];

  // Every index entry in the library (select("*") so a database without the
  // newest columns still answers).
  // The index and the sources are read side by side.
  const [{ rows: mirrors, error: mErr }, plan] = await Promise.all([
    fetchAllRows<MirrorRow>((from, to) => supabaseAdmin
      .from("knowledge_documents").select("*").eq("library_id", libraryId).order("id").range(from, to)),
    planKnowledgeSources(libraryId, false),
  ]);
  if (mErr) errors.push(`index: ${mErr}`);
  if (plan) errors.push(...plan.errors);

  const bySource = new Map<string, MirrorRow>();
  for (const m of mirrors) if (m.source_document_id) bySource.set(m.source_document_id, m);
  const facts = (m: MirrorRow): MirrorFacts => ({
    id: m.id, status: m.status, sourceVersionId: m.source_version_id,
    pagesIndexed: m.pages_indexed ?? 0, pageCount: m.page_count,
    error: m.error, touchedAt: m.updated_at ? new Date(m.updated_at).getTime() : null,
  });

  let linked: HealthSummary | null = null;
  if (plan) {
    const docs: SourceDocFacts[] = plan.all.map(({ doc, blocked }) => {
      const v = doc.current_version_id ? plan.versionById.get(doc.current_version_id) : undefined;
      return {
        id: doc.id,
        name: doc.document_number || doc.title || doc.name || "Document",
        blocked,
        currentVersionId: doc.current_version_id,
        fileUrl: v?.file_url ?? null,
        fileType: v?.file_type ?? null,
      };
    });
    // Restorable copies parked in OTHER knowledge libraries of the org.
    const retiredElsewhere = new Set<string>();
    const missingIds = docs.filter((d) => !bySource.has(d.id)).map((d) => d.id);
    if (missingIds.length && timeLeft() > 15_000) {
      const pages = await inSlices(missingIds, 100, 6, async (slice) => {
        const { data } = await supabaseAdmin.from("knowledge_documents").select("source_document_id")
          .eq("org_id", orgId).eq("status", "retired").in("source_document_id", slice);
        return (data ?? []) as Array<{ source_document_id: string }>;
      });
      for (const r of pages.flat()) retiredElsewhere.add(r.source_document_id);
    } else if (missingIds.length) {
      skipped.push("copies set aside in other libraries");
    }
    const mirrorsByDoc = new Map<string, MirrorFacts>();
    for (const [k, m] of bySource) mirrorsByDoc.set(k, facts(m));
    const extra = mirrors.filter((m) => m.source_document_id)
      .map((m) => ({ id: m.id, name: m.name, sourceDocumentId: m.source_document_id as string, status: m.status }));
    linked = summarize(docs, mirrorsByDoc, extra, now, { retiredElsewhere });
  }

  const uploads = mirrors.filter((m) => !m.source_document_id);
  const uploaded = {
    total: uploads.filter((m) => m.status !== "retired").length,
    ready: uploads.filter((m) => m.status === "ready" && (m.pages_indexed ?? 0) > 0 && (m.pages_indexed ?? 0) >= (m.page_count ?? 0)).length,
    waiting: uploads.filter((m) => m.status === "pending" || m.status === "stale" || m.status === "indexing").length,
    failed: uploads.filter((m) => m.status === "error").length,
    partial: uploads.filter((m) => m.status === "ready" && ((m.pages_indexed ?? 0) <= 0 || (m.pages_indexed ?? 0) < (m.page_count ?? 0))).length,
  };

  // Names: only for linked documents (uploaded PDFs are named by hand).
  const names: KnowledgeHealthReport["names"] = { wrong: 0, clashes: 0, samples: [], checked: false };
  if (plan && timeLeft() < 12_000) skipped.push("document names");
  else if (plan) {
    const found = await findNameFixes(plan.all.map(({ doc }) => doc.id));
    names.wrong = found.fixes.length;
    names.clashes = found.fixes.filter((f) => f.clash).length;
    // Clashes first: they're the ones that need a person.
    names.samples = [...found.fixes.filter((f) => f.clash), ...found.fixes.filter((f) => !f.clash)].slice(0, 300);
    names.checked = !found.error;
    if (found.error) errors.push(`names: ${found.error}`);
  }

  // While the meaning index is being built the chunk table is busy; a count
  // that times out is reported as "not available right now", never as 0.
  const countFor = Math.max(1_000, Math.min(8_000, timeLeft() - 2_000));
  const [chunks, embedded] = await Promise.all([
    count(() => supabaseAdmin.from("knowledge_chunks").select("id", { count: "exact", head: true }).eq("library_id", libraryId)
      .abortSignal(AbortSignal.timeout(countFor))),
    count(() => supabaseAdmin.from("knowledge_chunks").select("id", { count: "exact", head: true }).eq("library_id", libraryId).not("embedding", "is", null)
      .abortSignal(AbortSignal.timeout(countFor))),
  ]);

  return {
    checkedAt: new Date(now).toISOString(),
    libraryId,
    sources: (plan?.sources ?? []).map((s) => ({
      id: s.id,
      type: s.source_type,
      name: s.source_name ?? (s.source_type === "library" ? "Library" : "Folder"),
      exists: s.source_type === "library" ? plan!.landscape.libraries.has(s.source_id) : plan!.landscape.folders.has(s.source_id),
      neverAi: plan!.neverAiSources.includes(s.id),
    })),
    linked,
    uploaded,
    retired: mirrors.filter((m) => m.status === "retired").length,
    meaning: chunks === null || embedded === null ? null : { chunks, embedded },
    names,
    incomplete: !!plan?.incomplete || !!mErr || (!names.checked && !!plan && !skipped.includes("document names")),
    skipped,
    // A busy database (usually: the meaning index is being written) is said
    // once, plainly; other failures keep their reason.
    errors: Array.from(new Set(errors.map((e) => isBusyDbError(e)
      ? "The database was busy (the meaning index is being written) — Re-check in a few minutes."
      : e))),
  };
}

export interface RepairResult {
  sync: SourceSyncSummary | null;
  requeued: { failed: number; stuck: number; partial: number };
}

export async function repairKnowledgeLibrary(orgId: string, libraryId: string): Promise<RepairResult> {
  // 1. A complete sync (adds, refreshes, restores, retires — never deletes work).
  const { count: sourceCount } = await supabaseAdmin.from("knowledge_sources")
    .select("id", { count: "exact", head: true }).eq("library_id", libraryId);
  const sync = (sourceCount ?? 0) > 0 ? await syncKnowledgeLibrarySources(libraryId) : null;

  // 2. Re-queue what's stuck, failed or partly read. Reading resumes from
  //    the last page done; pages already read are not paid for again.
  const { rows } = await fetchAllRows<MirrorRow>((from, to) => supabaseAdmin
    .from("knowledge_documents").select("*").eq("library_id", libraryId)
    .in("status", ["error", "indexing", "ready"]).order("id").range(from, to));
  const now = Date.now();
  const failed = rows.filter((m) => m.status === "error").map((m) => m.id);
  const stuck = rows.filter((m) => m.status === "indexing" && m.updated_at && now - new Date(m.updated_at).getTime() > STUCK_AFTER_MS).map((m) => m.id);
  const partial = rows.filter((m) => m.status === "ready" && ((m.pages_indexed ?? 0) <= 0 || (m.page_count ?? 0) > (m.pages_indexed ?? 0))).map((m) => m.id);
  for (const ids of [failed, stuck, partial]) {
    await inSlices(ids, 100, 4, (slice) => supabaseAdmin.from("knowledge_documents")
      .update({ status: "pending", error: null }).in("id", slice).then(() => undefined));
  }

  // No report here: sync + report in one request is what ran past the
  // host's limit. The panel asks for a fresh report as its own request.
  return { sync, requeued: { failed: failed.length, stuck: stuck.length, partial: partial.length } };
}

export interface NameRepairResponse {
  names: NameRepairResult;
}

/** One round of correcting the names the old filename reader got wrong in
 *  this library's linked documents, inside the host's time limit. The
 *  caller repeats while `names.remaining > 0`, passing back the ids it was
 *  told need a person (`exclude`) so they aren't retried, then runs Repair
 *  (a sync, so the index cites the documents by their real names) and asks
 *  for a fresh report — each its own request. */
export async function repairLinkedDocumentNames(orgId: string, libraryId: string, uid: string, exclude: string[] = []): Promise<NameRepairResponse> {
  const started = Date.now();
  const plan = await planKnowledgeSources(libraryId, false);
  const { fixes } = plan ? await findNameFixes(plan.all.map(({ doc }) => doc.id)) : { fixes: [] };
  const skip = new Set(exclude);
  const names = await repairDocumentNames(orgId, fixes.filter((f) => !skip.has(f.id)).map((f) => f.id), uid, started + 40_000);
  return { names };
}
