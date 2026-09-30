// /api/knowledge/ingest — turn a knowledge document's PDF into searchable
// chunks, one client-driven batch at a time.
//
// A 900-page standard cannot be indexed inside one serverless invocation, so
// the CLIENT drives batches: POST { documentId } repeatedly; each call
// ingests the next PAGE_BATCH pages and reports progress. The loop is
// resumable — a dropped connection or timeout just re-POSTs and picks up at
// pages_indexed. The maintenance cron drains the same queue in the
// background (lib/knowledgeIngest is the single engine for both).
//
// Scanned (image-only) pages yield no text; we count them. The count is kept
// on the document row (knowledge_documents.empty_pages, reset with the rest
// of the index) and every response carries the running total as
// emptyPagesTotal — the number behind "34 of 900 pages had no extractable
// text" — rather than a per-batch figure nobody reads (ING-11).
//
// One driver at a time (ING-2): the engine claims the document per batch. A
// POST that finds another driver mid-batch WAITS for it (never errors the
// document) and answers `busy` with the row's progress if it is still held.
// A file that is not a PDF is refused on its first batch, by its bytes,
// before pdf.js sees it (ING-9 — the engine checks, whichever driver gets
// there first; refuseNonPdf is the one refusal). Pages AI vision could not
// read that cannot be retried right now (no key, or the provider refused
// again) answer 409 with the plain reason — the document keeps its index
// and stays 'indexing', never 'error' (ING-6).

import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { openAiKey } from "@/lib/ai/keyVault";
import {
  ingestKnowledgeDocBatch, refuseNonPdf, reindexLibraryChunks, rebuildDocumentMentions,
  claimIngestLease, releaseIngestLease,
  type VisionContext, type IngestBatchResult,
} from "@/lib/knowledgeIngest";
import { memberHoldsAny } from "@/lib/roleHeld";
import { loadOrgInstructionsBlock } from "@/lib/aiInstructionsServer";
import { ALLOWED_PROVIDERS, estimateCostUsd, type AiUsage } from "@/lib/ai/pricing";
import { getMonthUsage, getCapUsd, recordAskUsage } from "@/lib/ai/usageServer";
import type { AiProviderId } from "@/lib/ai/providerCall";

export const runtime = "nodejs";
// Hobby functions are killed at 60s no matter what maxDuration says, so the
// real budget is the one we enforce ourselves — see INVOCATION_BUDGET_MS.
export const maxDuration = 60;

/** Stop and commit with time to spare. A killed invocation writes NOTHING
 *  (every insert happens after the page loop), so pages_indexed wouldn't
 *  advance and the client would re-POST the same range forever — indexing
 *  stuck at zero with a 504 in the console. Finishing early always beats
 *  being killed. */
const INVOCATION_BUDGET_MS = 45_000;

/** While another driver holds the document's claim, look again this often —
 *  and stop waiting once less than a batch's worth of the budget is left. */
const BUSY_POLL_MS = 1_500;
const MIN_BATCH_MS = 15_000;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

const pageList = (v: unknown): number[] =>
  Array.isArray(v) ? [...new Set(v.map(Number).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b) : [];

export async function POST(req: NextRequest) {
  const deadlineMs = Date.now() + INVOCATION_BUDGET_MS;
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Unauthorized", 401);
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authError || !user) return bad("Unauthorized", 401);

  let body: { documentId?: string; action?: string; libraryId?: string; chunker?: number; dryRun?: boolean };
  try { body = await req.json(); } catch { return bad("Expected JSON body"); }
  if (body.action === "reindex") {
    return reindex(String(body.libraryId ?? "").trim(), body.chunker, user.id, body.dryRun === true, deadlineMs);
  }
  const documentId = String(body.documentId ?? "").trim();
  if (!documentId) return bad("documentId is required");

  const { data: doc } = await supabaseAdmin
    .from("knowledge_documents").select("*").eq("id", documentId).maybeSingle();
  if (!doc) return bad("Document not found", 404);

  // Ingest is a controller action (same bar as adding library documents).
  // The role COLLECTION decides, never the headline alone (ADD-1).
  const { data: member } = await supabaseAdmin
    .from("org_members").select("role, roles")
    .eq("org_id", doc.org_id as string).eq("uid", user.id).eq("status", "active")
    .maybeSingle();
  if (!member || !memberHoldsAny(member, ["Admin", "DocCtrl"])) {
    return bad("Only Admin or Doc Control can index documents.", 403);
  }

  if (body.action === "accept-partial") return acceptPartial(doc as Record<string, unknown>, user.id);
  if (body.action) return bad("Unknown action");

  if (doc.status === "ready") {
    return NextResponse.json({ done: true, pageCount: doc.page_count, pagesIndexed: doc.pages_indexed });
  }

  // ── Vision fallback context ────────────────────────────────────────────
  // Pages with no text layer (AutoCAD SHX exports, scans) get READ by the
  // model. It spends THIS user's key — the person who triggered indexing —
  // metered as its own op and stopped at their monthly cap. No key or no
  // headroom just means text-only indexing, never a failure.
  const orgId = doc.org_id as string;
  // Library option: read EVERY page with vision (drawing sets where even the
  // text layer can't be trusted).
  const { data: libRow } = await supabaseAdmin
    .from("knowledge_libraries").select("ai_features")
    .eq("id", doc.library_id as string).maybeSingle();
  const forceAllPages =
    ((libRow?.ai_features ?? {}) as Record<string, unknown>).visionAllPages === true;
  const visionUsage: AiUsage = { inputTokens: 0, outputTokens: 0 };
  let visionModel = "";
  let vision: VisionContext | undefined;
  let visionSkipReason: string | null = null;
  {
    const { data: conn } = await supabaseAdmin
      .from("ai_connections").select("provider, model, api_key")
      .eq("org_id", orgId).eq("user_id", user.id).maybeSingle();
    const usable = !!conn && ALLOWED_PROVIDERS.includes(conn.provider as AiProviderId);
    if (!usable) {
      visionSkipReason = "Add your AI key in AI settings to read pages that have no text layer.";
    } else {
      const [spent, cap] = await Promise.all([
        getMonthUsage(orgId, user.id),
        getCapUsd(orgId, user.id),
      ]);
      if (cap > 0 && spent.spentUsd >= cap) {
        visionSkipReason = `Monthly AI budget reached ($${spent.spentUsd.toFixed(2)} of $${cap.toFixed(2)}) — ` +
          "pages without a text layer were skipped. They index automatically once the cap resets or is raised.";
      } else {
        vision = {
          provider: conn!.provider as AiProviderId,
          model: conn!.model as string,
          apiKey: openAiKey(conn!.api_key as string),
          instructions: await loadOrgInstructionsBlock(supabaseAdmin, orgId, "equipment"),
          // Bounded per invocation: render + transcribe is seconds per page
          // and free-tier functions die at 60s. The client loop continues.
          budgetPages: 4,
          forceAllPages,
          onUsage: (u, model) => {
            visionUsage.inputTokens += u.inputTokens;
            visionUsage.outputTokens += u.outputTokens;
            visionModel = model;
          },
        };
      }
    }
  }

  try {
    const row = {
      id: doc.id as string,
      org_id: orgId,
      library_id: doc.library_id as string,
      name: doc.name as string,
      file_key: doc.file_key as string,
      status: doc.status as string,
      pages_indexed: (doc.pages_indexed as number | null) ?? 0,
      page_count: doc.page_count as number | null,
      last_section: (doc.last_section as string | null) ?? null,
      source_document_id: (doc.source_document_id as string | null) ?? null,
      // What the batch compares against at commit (ING-1) when it runs
      // unclaimed on a pre-20261122 database.
      ...("source_version_id" in doc ? { source_version_id: (doc.source_version_id as string | null) ?? null } : {}),
    };
    let res: IngestBatchResult = await ingestKnowledgeDocBatch(row, vision, deadlineMs);
    // The loser WAITS (ING-2): the other driver holds the claim for one batch
    // at most. Look again until it lets go, while a batch still fits.
    while (res.busy && Date.now() + BUSY_POLL_MS + MIN_BATCH_MS < deadlineMs) {
      await new Promise((r) => setTimeout(r, BUSY_POLL_MS));
      res = await ingestKnowledgeDocBatch(row, vision, deadlineMs);
    }

    // ── Not a PDF at all (ING-9): the bytes said so before pdf.js saw them.
    //    An upload leaves nothing behind; a mirror is marked (refuseNonPdf).
    if (res.notPdf) {
      const refused = await refuseNonPdf(doc as Record<string, unknown>, res.notPdf, user.id);
      if (refused.error) return bad(`${refused.message} (${refused.error})`, 415);
      return NextResponse.json({ error: refused.message, removed: refused.removed, detected: res.notPdf }, { status: 415 });
    }

    if (visionUsage.inputTokens + visionUsage.outputTokens > 0) {
      await recordAskUsage({
        orgId, userId: user.id,
        provider: vision!.provider, model: visionModel || vision!.model,
        usage: visionUsage, ok: true, op: "knowledgeVision",
      });
    }

    if (res.done && !res.busy) await onIndexed(doc as Record<string, unknown>, user.id, res.pageCount, res.visionPages);

    // Pages AI vision failed to read are said, not swallowed (ING-6) — on
    // the same channel as the other reasons a page went unread.
    if (res.visionFailedPages.length > 0) {
      const n = res.visionFailedPages.length;
      const note = `${n} page${n === 1 ? "" : "s"} could not be read by AI vision` +
        (res.visionError ? ` (${res.visionError})` : "") +
        " — retried automatically; the document is not marked ready until they are read or the partial index is accepted.";
      visionSkipReason = visionSkipReason ? `${visionSkipReason} ${note}` : note;
    }

    const visionCostUsd = visionUsage.inputTokens + visionUsage.outputTokens > 0
      ? estimateCostUsd(visionModel || vision!.model, visionUsage)
      : 0;
    if (res.visionRetryBlocked) {
      // Nothing failed and nothing was lost: the reason is on the row and
      // here. A non-2xx stops the caller's loop with this message instead of
      // a misleading "stalled" one; the document stays 'indexing'.
      return NextResponse.json({
        ...res, visionSkipReason, visionCostUsd, error: res.visionRetryMessage,
      }, { status: 409 });
    }
    return NextResponse.json({ ...res, visionSkipReason, visionCostUsd });
  } catch (e) {
    const message = (e as Error).message;
    await supabaseAdmin.from("knowledge_documents")
      .update({ status: "error", error: message.slice(0, 500) })
      .eq("id", doc.id as string);
    return bad(`Indexing failed: ${message}`, 502);
  }
}

/** The audit row for a document reaching 'ready'. (The mention pass that
 *  draws its document↔equipment edges runs where the document becomes
 *  'ready' — inside the engine for a batch, so the cron drain gets it too,
 *  and in acceptPartial below.) */
async function onIndexed(doc: Record<string, unknown>, userId: string, pages: number, visionPages: number) {
  await supabaseAdmin.from("audit_logs").insert({
    action: "KNOWLEDGE_DOC_INDEXED",
    resource_type: "knowledge_document", resource_id: String(doc.id),
    org_id: doc.org_id, user_id: userId,
    details: { name: doc.name, pages, visionPages },
  }).then(() => undefined, () => undefined);
}

/** ING-6's explicit exit: a controller accepts a document whose remaining
 *  pages AI vision could not read. It becomes 'ready' with those pages still
 *  listed on the row (vision_failed_pages) — the count stays visible — and
 *  the acceptance is audited with the page list. It takes the document's
 *  ingest claim like any writer, so a retry batch in flight can neither be
 *  overwritten by it nor undo it: the acceptance and the claim's release
 *  are one UPDATE. */
async function acceptPartial(doc: Record<string, unknown>, userId: string) {
  if (pageList(doc.vision_failed_pages).length === 0) return bad("Nothing to accept — no page is waiting on AI vision.", 409);
  const driver = `accept:${randomUUID()}`;
  let lease: Awaited<ReturnType<typeof claimIngestLease>>;
  try { lease = await claimIngestLease(String(doc.id), driver); }
  catch (e) { return bad(`Could not accept the partial index: ${(e as Error).message}`, 500); }
  if (lease.kind === "gone") return bad("Document not found", 404);
  if (lease.kind === "busy") {
    return bad("This document is being indexed right now — try again in a moment.", 409);
  }
  // The row as claimed: the freshest page list and progress.
  const row = lease.kind === "claimed" ? lease.row : doc;
  const failed = pageList(row.vision_failed_pages);
  const refuse = async (msg: string) => {
    if (lease.kind === "claimed") await releaseIngestLease(String(doc.id), driver);
    return bad(msg, 409);
  };
  if (failed.length === 0) return refuse("Nothing to accept — no page is waiting on AI vision.");
  if (Number(row.pages_indexed ?? 0) < Number(row.page_count ?? Infinity)) {
    return refuse("Indexing has not reached the end of this document yet — let it finish first.");
  }
  const known = new Set(Object.keys(row));
  const update = Object.fromEntries(Object.entries({
    vision_partial_accepted: true, status: "ready", error: null, vision_retry_after: null,
    ingest_claimed_by: null, ingest_claimed_at: null,
  }).filter(([k]) => known.has(k)));
  let q = supabaseAdmin.from("knowledge_documents").update(update).eq("id", String(doc.id));
  if (lease.kind === "claimed") q = q.eq("ingest_claimed_by", driver);
  const { data, error } = await q.select("id");
  if (error) {
    if (lease.kind === "claimed") await releaseIngestLease(String(doc.id), driver);
    return bad(`Could not accept the partial index: ${error.message}`, 500);
  }
  if ((data ?? []).length === 0) return bad("The document changed while it was being accepted — reload and try again.", 409);
  await supabaseAdmin.from("audit_logs").insert({
    action: "KNOWLEDGE_DOC_PARTIAL_ACCEPTED",
    resource_type: "knowledge_document", resource_id: String(doc.id),
    org_id: doc.org_id, user_id: userId,
    details: { name: doc.name, unreadPages: failed },
  }).then(() => undefined, () => undefined);
  await onIndexed(doc, userId, Number(row.page_count ?? 0), Number(row.vision_pages ?? 0));
  await rebuildDocumentMentions({
    id: String(doc.id), org_id: String(doc.org_id),
    source_document_id: (doc.source_document_id as string | null) ?? null,
  });
  return NextResponse.json({ ok: true, done: true, acceptedPages: failed });
}

/** "Re-index with table-aware chunking" (ING-4 / ING-7): the explicit,
 *  per-library switch to chunker 2 (or back to 1). Controller-only, like
 *  indexing itself.
 *
 *    - `dryRun: true` changes NOTHING and answers what a run would do: the
 *      documents it would reset and the AI-vision pages they would re-read
 *      (and bill) — the number to confirm before anything is deleted.
 *    - A real run records the intent in the audit log FIRST (a run that
 *      cannot be recorded does not start), then resets the library's
 *      documents through the one shared reset until this invocation's
 *      deadline, and answers `remaining`: run it again to continue. A
 *      document already on the chosen chunker (or not yet indexed) is
 *      skipped, so a re-run never resets — or re-bills — one twice, and a
 *      document being indexed at that moment is reported busy and picked up
 *      by the next run. */
async function reindex(libraryId: string, chunker: unknown, userId: string, dryRun: boolean, deadlineMs: number) {
  if (!libraryId) return bad("libraryId is required");
  if (chunker !== 1 && chunker !== 2) return bad("chunker must be 1 or 2");
  const { data: lib } = await supabaseAdmin
    .from("knowledge_libraries").select("id, org_id, name").eq("id", libraryId).maybeSingle();
  if (!lib) return bad("Library not found", 404);
  const { data: member } = await supabaseAdmin
    .from("org_members").select("role, roles")
    .eq("org_id", lib.org_id as string).eq("uid", userId).eq("status", "active")
    .maybeSingle();
  if (!member || !memberHoldsAny(member, ["Admin", "DocCtrl"])) {
    return bad("Only Admin or Doc Control can re-index a library.", 403);
  }
  const failed = (e: unknown) => {
    const message = (e as Error).message;
    return bad(message, /needs migration/.test(message) ? 424 : 500);
  };
  let plan: Awaited<ReturnType<typeof reindexLibraryChunks>>;
  try {
    plan = await reindexLibraryChunks(libraryId, chunker, { dryRun: true });
  } catch (e) { return failed(e); }
  if (dryRun) {
    return NextResponse.json({
      ok: true, dryRun: true, chunker,
      documents: plan.documents, toReset: plan.toReset, visionPagesToReread: plan.visionPagesToReread,
    });
  }

  // The intent, recorded before anything is reset.
  const { error: auditErr } = await supabaseAdmin.from("audit_logs").insert({
    action: "KNOWLEDGE_LIBRARY_REINDEXED",
    resource_type: "knowledge_library", resource_id: libraryId,
    org_id: lib.org_id, user_id: userId,
    details: {
      name: lib.name, chunker, documents: plan.documents,
      toReset: plan.toReset, visionPagesToReread: plan.visionPagesToReread,
    },
  });
  if (auditErr) return bad(`The re-index could not be recorded, so nothing was changed: ${auditErr.message}`, 500);

  let out: Awaited<ReturnType<typeof reindexLibraryChunks>>;
  try {
    out = await reindexLibraryChunks(libraryId, chunker, { deadlineMs });
  } catch (e) { return failed(e); }
  return NextResponse.json({
    ok: out.errors.length === 0, chunker,
    reset: out.reset.length, busy: out.busy.length, errors: out.errors.slice(0, 20),
    toReset: out.toReset, visionPagesToReread: out.visionPagesToReread, remaining: out.remaining,
  }, { status: out.errors.length === 0 ? 200 : 207 });
}
