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
import { planKnowledgeSources, syncKnowledgeLibrarySources, type SourceSyncSummary } from "@/lib/knowledgeSourceSync";
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
  meaning: { chunks: number; embedded: number };
  /** A read failed part-way — the numbers may be short; Repair won't remove anything. */
  incomplete: boolean;
  errors: string[];
}

async function count(build: () => PromiseLike<{ count: number | null }>): Promise<number> {
  try { return (await build()).count ?? 0; } catch { return 0; }
}

export async function knowledgeHealthReport(orgId: string, libraryId: string): Promise<KnowledgeHealthReport> {
  const now = Date.now();
  const errors: string[] = [];

  // Every index entry in the library (select("*") so a database without the
  // newest columns still answers).
  const { rows: mirrors, error: mErr } = await fetchAllRows<MirrorRow>((from, to) => supabaseAdmin
    .from("knowledge_documents").select("*").eq("library_id", libraryId).order("id").range(from, to));
  if (mErr) errors.push(`index: ${mErr}`);

  const plan = await planKnowledgeSources(libraryId, false);
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
    for (let i = 0; i < missingIds.length; i += 100) {
      const { data, error } = await supabaseAdmin.from("knowledge_documents").select("source_document_id")
        .eq("org_id", orgId).eq("status", "retired").in("source_document_id", missingIds.slice(i, i + 100));
      if (error) break;
      for (const r of (data ?? []) as Array<{ source_document_id: string }>) retiredElsewhere.add(r.source_document_id);
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

  const [chunks, embedded] = await Promise.all([
    count(() => supabaseAdmin.from("knowledge_chunks").select("id", { count: "exact", head: true }).eq("library_id", libraryId)),
    count(() => supabaseAdmin.from("knowledge_chunks").select("id", { count: "exact", head: true }).eq("library_id", libraryId).not("embedding", "is", null)),
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
    meaning: { chunks, embedded },
    incomplete: !!plan?.incomplete || !!mErr,
    errors,
  };
}

export interface RepairResult {
  sync: SourceSyncSummary | null;
  requeued: { failed: number; stuck: number; partial: number };
  report: KnowledgeHealthReport;
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
    for (let i = 0; i < ids.length; i += 100) {
      await supabaseAdmin.from("knowledge_documents").update({ status: "pending", error: null })
        .in("id", ids.slice(i, i + 100));
    }
  }

  const report = await knowledgeHealthReport(orgId, libraryId);
  return { sync, requeued: { failed: failed.length, stuck: stuck.length, partial: partial.length }, report };
}
