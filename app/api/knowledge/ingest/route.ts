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
// before pdf.js sees it (ING-9).

import { NextRequest, NextResponse } from "next/server";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { r2, R2_BUCKET } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { openAiKey } from "@/lib/ai/keyVault";
import {
  ingestKnowledgeDocBatch, sniffStoredFile, notPdfMessage, reindexLibraryChunks,
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

  let body: { documentId?: string; action?: string; libraryId?: string; chunker?: number };
  try { body = await req.json(); } catch { return bad("Expected JSON body"); }
  if (body.action === "reindex") return reindex(String(body.libraryId ?? "").trim(), body.chunker, user.id);
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

  // ── Is it a PDF at all? (ING-9) ────────────────────────────────────────
  // The browser's .pdf check is advisory; the bytes decide, on the first
  // batch, before pdf.js ever sees them. An uploaded non-PDF leaves nothing
  // behind — its row and its R2 object go — and the refusal names where the
  // file belongs. A mirrored controlled file is never deleted (the object is
  // doc control's): its row is marked with the same plain message.
  if (Number(doc.pages_indexed ?? 0) === 0) {
    let kind: Awaited<ReturnType<typeof sniffStoredFile>> | null = null;
    try { kind = await sniffStoredFile(doc.file_key as string); } catch { kind = null; }
    if (kind && kind !== "pdf") {
      const message = notPdfMessage(String(doc.name ?? "This file"), kind);
      const uploaded = !doc.source_document_id && !doc.source_id &&
        String(doc.file_key ?? "").startsWith(`orgs/${doc.org_id as string}/knowledge/`);
      if (uploaded) {
        const { error: delErr } = await supabaseAdmin.from("knowledge_documents").delete().eq("id", documentId);
        if (delErr) return bad(`${message} (The upload could not be removed: ${delErr.message})`, 415);
        await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: doc.file_key as string }))
          .catch(() => undefined); // the orphan sweeper reclaims an object whose delete failed
        await supabaseAdmin.from("audit_logs").insert({
          action: "KNOWLEDGE_DOC_REJECTED",
          resource_type: "knowledge_document", resource_id: documentId,
          org_id: doc.org_id, user_id: user.id,
          details: { name: doc.name, detected: kind, reason: "not a PDF" },
        }).then(() => undefined, () => undefined);
        return NextResponse.json({ error: message, removed: true, detected: kind }, { status: 415 });
      }
      const { error: markErr } = await supabaseAdmin.from("knowledge_documents")
        .update({ status: "error", error: message.slice(0, 500) }).eq("id", documentId);
      if (markErr) return bad(`${message} (${markErr.message})`, 415);
      return NextResponse.json({ error: message, removed: false, detected: kind }, { status: 415 });
    }
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

    return NextResponse.json({
      ...res,
      visionSkipReason,
      visionCostUsd: visionUsage.inputTokens + visionUsage.outputTokens > 0
        ? estimateCostUsd(visionModel || vision!.model, visionUsage)
        : 0,
    });
  } catch (e) {
    const message = (e as Error).message;
    await supabaseAdmin.from("knowledge_documents")
      .update({ status: "error", error: message.slice(0, 500) })
      .eq("id", doc.id as string);
    return bad(`Indexing failed: ${message}`, 502);
  }
}

/** Everything that follows a document reaching 'ready': the audit row and
 *  the mention pass that draws its document↔equipment edges. */
async function onIndexed(doc: Record<string, unknown>, userId: string, pages: number, visionPages: number) {
  await supabaseAdmin.from("audit_logs").insert({
    action: "KNOWLEDGE_DOC_INDEXED",
    resource_type: "knowledge_document", resource_id: String(doc.id),
    org_id: doc.org_id, user_id: userId,
    details: { name: doc.name, pages, visionPages },
  }).then(() => undefined, () => undefined);

  // Feed the GRAPH the moment indexing finishes. The mention indexer —
  // which draws every document↔equipment edge on the graph page — had
  // no automatic trigger at all: its API route had zero callers, so
  // the graph only knew about documents someone manually indexed.
  // Best-effort with a hard time cap; a slow scan never fails ingest.
  try {
    const { loadAliasDictionary, indexDocumentMentions } = await import("@/lib/mentionIndexer");
    const dict = await loadAliasDictionary(String(doc.org_id));
    if (dict.length > 0) {
      await Promise.race([
        indexDocumentMentions(
          String(doc.org_id), String(doc.id), dict,
          (doc.source_document_id as string | null) ?? null,
        ),
        new Promise((r) => setTimeout(r, 8_000)),
      ]);
    }
  } catch { /* mention edges are a bonus — never block ingestion */ }
}

/** ING-6's explicit exit: a controller accepts a document whose remaining
 *  pages AI vision could not read. It becomes 'ready' with those pages still
 *  listed on the row (vision_failed_pages) — the count stays visible — and
 *  the acceptance is audited with the page list. */
async function acceptPartial(doc: Record<string, unknown>, userId: string) {
  const failed = pageList(doc.vision_failed_pages);
  if (failed.length === 0) return bad("Nothing to accept — no page is waiting on AI vision.", 409);
  if (Number(doc.pages_indexed ?? 0) < Number(doc.page_count ?? Infinity)) {
    return bad("Indexing has not reached the end of this document yet — let it finish first.", 409);
  }
  const { data, error } = await supabaseAdmin.from("knowledge_documents")
    .update({ vision_partial_accepted: true, status: "ready", error: null })
    .eq("id", String(doc.id)).select("id");
  if (error) return bad(`Could not accept the partial index: ${error.message}`, 500);
  if ((data ?? []).length === 0) return bad("Document not found", 404);
  await supabaseAdmin.from("audit_logs").insert({
    action: "KNOWLEDGE_DOC_PARTIAL_ACCEPTED",
    resource_type: "knowledge_document", resource_id: String(doc.id),
    org_id: doc.org_id, user_id: userId,
    details: { name: doc.name, unreadPages: failed },
  }).then(() => undefined, () => undefined);
  await onIndexed(doc, userId, Number(doc.page_count ?? 0), Number(doc.vision_pages ?? 0));
  return NextResponse.json({ ok: true, done: true, acceptedPages: failed });
}

/** "Re-index with table-aware chunking" (ING-4 / ING-7): the explicit,
 *  per-library switch to chunker 2 (or back to 1). Controller-only, like
 *  indexing itself. Every document of the library is reset through the one
 *  shared reset and re-indexes from its first page; a document being
 *  indexed at that moment is reported busy, not reset under its batch. The
 *  response says how many AI-vision pages will be read again. */
async function reindex(libraryId: string, chunker: unknown, userId: string) {
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
  let out: Awaited<ReturnType<typeof reindexLibraryChunks>>;
  try {
    out = await reindexLibraryChunks(libraryId, chunker);
  } catch (e) {
    const message = (e as Error).message;
    return bad(message, /needs migration/.test(message) ? 424 : 500);
  }
  await supabaseAdmin.from("audit_logs").insert({
    action: "KNOWLEDGE_LIBRARY_REINDEXED",
    resource_type: "knowledge_library", resource_id: libraryId,
    org_id: lib.org_id, user_id: userId,
    details: {
      name: lib.name, chunker, reset: out.reset.length, busy: out.busy.length,
      errors: out.errors.length, visionPagesToReread: out.visionPagesToReread,
    },
  }).then(() => undefined, () => undefined);
  return NextResponse.json({
    ok: out.errors.length === 0, chunker,
    reset: out.reset.length, busy: out.busy.length, errors: out.errors.slice(0, 20),
    visionPagesToReread: out.visionPagesToReread,
  }, { status: out.errors.length === 0 ? 200 : 207 });
}
