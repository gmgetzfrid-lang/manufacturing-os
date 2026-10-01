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
// document) and answers `busy` with the row's progress if it is still held,
// and `retryAfterMs`: at most how long until that claim is free (a claim a
// killed invocation left behind stands for the whole TTL) — a caller that
// keeps meeting `busy` is waiting, not stalled.
// A file that is not a PDF is refused on its first batch (ING-9 — the
// engine checks, whichever driver gets there first: another format's bytes
// before pdf.js sees them, a file with no PDF header once pdf.js cannot open
// it either; refuseNonPdf is the one refusal). A failed batch is written
// onto the document only while the row is still the file it read (ING-1 —
// markIngestFailed), and is retried automatically after a back-off, a
// bounded number of times, before the document becomes 'error' (ING-8). Pages
// AI vision could not read that cannot be retried right now (no key, or the
// provider refused again), and a failed batch still waiting out its back-off,
// answer 409 with the plain reason — the document keeps its index and its
// status, never 'error' (ING-6, ING-8). The route cannot tell a person's
// click from the automatic loops (the library page's, the app-shell
// indicator's), so a person's explicit re-run says so: `retryNow: true`
// skips a failed batch's back-off, audited (KNOWLEDGE_DOC_RETRY_NOW) once the
// engine lets it through and before anything runs — never for one refused.
// The library page's Resume is to pass it (I-02); the automatic loops never
// do.

import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { openAiKey } from "@/lib/ai/keyVault";
import {
  ingestKnowledgeDocBatch, refuseNonPdf, reindexLibraryChunks, onDocumentReady, markIngestFailed,
  claimIngestLease, releaseIngestLease,
  type VisionContext, type IngestBatchResult,
} from "@/lib/knowledgeIngest";
import { memberHoldsAny } from "@/lib/roleHeld";
import { loadOrgInstructionsBlock } from "@/lib/aiInstructionsServer";
import { ALLOWED_PROVIDERS, AGREEMENT_VERSION, estimateCostUsd, type AiUsage } from "@/lib/ai/pricing";
import { getMonthUsage, getCapUsd, recordAskUsage } from "@/lib/ai/usageServer";
import { isAiUsageUnavailable } from "@/lib/ai/gateError";
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

  let body: { documentId?: string; action?: string; libraryId?: string; chunker?: number; dryRun?: boolean; retryNow?: boolean };
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

  // ── A person's explicit re-run (ING-8) ─────────────────────────────────
  // `retryNow` skips a failed batch's back-off: someone fixed the cause (a
  // connection, their AI budget) and wants it tried now, not on the next
  // pass. Controller-only like the rest of this route, and audited before
  // anything runs — a re-run that cannot be recorded runs nothing. It is
  // recorded only when the engine lets it through and is about to perform
  // it (`onRetryNow`): under the claim, with a failed batch's back-off in
  // force (in either stage — the main pass or a vision-retry batch), and
  // with a key that can read the pages waiting on AI vision. So nothing is
  // recorded for a POST that only meets `busy`, for a vision retry's own
  // back-off (ING-6: the 409 with its reason), for a re-run this person
  // has no usable key for (the 409 with that reason; the failure's record
  // stays on the row), or with no back-off in force (an ordinary batch).
  const retry = body.retryNow === true
    ? {
      retryNow: true,
      onRetryNow: async (row: Record<string, unknown>, backoffUntil: string): Promise<string | null> => {
        const { error: auditErr } = await supabaseAdmin.from("audit_logs").insert({
          action: "KNOWLEDGE_DOC_RETRY_NOW",
          resource_type: "knowledge_document", resource_id: documentId,
          org_id: doc.org_id, user_id: user.id,
          details: {
            name: row.name ?? doc.name, fileKey: row.file_key, sourceVersionId: row.source_version_id ?? null,
            failures: row.ingest_failures, backoffUntil, lastError: row.error,
          },
        });
        return auditErr ? auditErr.message : null;
      },
    }
    : {};

  // ── Vision fallback context ────────────────────────────────────────────
  // Pages with no text layer (AutoCAD SHX exports, scans) get READ by the
  // model. It spends THIS user's key — the person who triggered indexing —
  // metered as its own op and stopped at their monthly cap. No key, no
  // signed agreement or no headroom just means text-only indexing, never a
  // failure.
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
  // GOV-11 / GOV-4: the reason vision was withheld when it is NOT the missing
  // key or budget the engine's own "retrying needs an AI key" sentence names
  // — so pages waiting on AI vision are parked (on the row, and in the 409)
  // with the cause the person can act on, never "add a key" to a member who
  // has one but has not accepted the agreement.
  let noVisionReason: string | null = null;
  {
    const { data: conn } = await supabaseAdmin
      .from("ai_connections").select("provider, model, api_key")
      .eq("org_id", orgId).eq("user_id", user.id).maybeSingle();
    const usable = !!conn && ALLOWED_PROVIDERS.includes(conn.provider as AiProviderId);
    // GOV-11: page images are org content sent to the provider — the same
    // acceptance the drain's sponsor path (loadSponsorVision) and every other
    // content route require, at the current AGREEMENT_VERSION. Unsigned (or
    // an older version) skips vision only; an acceptance record that cannot
    // be read is never taken as signed. A database without the table is
    // pre-agreement, as in loadSponsorVision.
    let agreement: "signed" | "unsigned" | "unreadable" = "unsigned";
    if (usable) {
      const { data: agree, error: agreeError } = await supabaseAdmin
        .from("ai_key_agreements").select("id")
        .eq("org_id", orgId).eq("user_id", user.id)
        .eq("scope", "use").eq("agreement_version", AGREEMENT_VERSION).limit(1);
      const agreementTableMissing = !!agreeError && (agreeError.code === "42P01" || /does not exist/i.test(agreeError.message));
      agreement = agreementTableMissing || (!agreeError && (agree ?? []).length > 0) ? "signed"
        : agreeError ? "unreadable" : "unsigned";
    }
    if (!usable) {
      visionSkipReason = "Add your AI key in AI settings to read pages that have no text layer.";
    } else if (agreement === "unsigned") {
      visionSkipReason = "Accept the AI acceptable-use agreement to read pages that have no text layer — they are sent " +
        "to your AI provider as images (ask any question in Knowledge to be prompted).";
      noVisionReason = visionSkipReason;
    } else if (agreement === "unreadable") {
      visionSkipReason = "Your AI acceptable-use agreement can't be checked right now, so pages without a text layer were skipped.";
      noVisionReason = visionSkipReason;
    } else {
      // GOV-4: a ledger that cannot be read refuses the AI step only — the
      // text layer still indexes (no headroom is text-only, never a failure).
      const ledger = await Promise.all([
        getMonthUsage(orgId, user.id),
        getCapUsd(orgId, user.id),
      ]).catch((e: unknown) => { if (isAiUsageUnavailable(e)) return null; throw e; });
      const [spent, cap] = ledger ?? [null, 0];
      if (!spent) {
        visionSkipReason = "AI usage can't be read right now, so pages without a text layer were skipped — " +
          "they index automatically once it can.";
        noVisionReason = visionSkipReason;
      } else if (cap > 0 && spent.spentUsd >= cap) {
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
    const batchOpts = { ...retry, noVisionReason };
    let res: IngestBatchResult = await ingestKnowledgeDocBatch(row, vision, deadlineMs, batchOpts);
    // The loser WAITS (ING-2): the other driver holds the claim for one batch
    // at most. Look again until it lets go, while a batch still fits.
    while (res.busy && Date.now() + BUSY_POLL_MS + MIN_BATCH_MS < deadlineMs) {
      await new Promise((r) => setTimeout(r, BUSY_POLL_MS));
      res = await ingestKnowledgeDocBatch(row, vision, deadlineMs, batchOpts);
    }
    if (res.retryNowError) {
      return bad(`The re-run could not be recorded, so nothing was run: ${res.retryNowError}`, 500);
    }

    // ── Not a PDF at all (ING-9). An upload leaves nothing behind; a
    //    mirror is marked (refuseNonPdf) — unless a rev-up re-pointed the
    //    row since the file was checked: then nothing is refused, and the
    //    answer is the same as any batch the rev-up superseded.
    if (res.notPdf) {
      const refused = await refuseNonPdf(doc as Record<string, unknown>, res.notPdf, user.id, res.notPdfRead);
      if (refused.superseded) {
        const { notPdfRead: _read, ...pub } = res;
        return NextResponse.json({ ...pub, notPdf: null, superseded: true, done: false });
      }
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
    // the same channel as the other reasons a page went unread. A database
    // without 20261122 (`legacy`) has nowhere to hold them for a retry: the
    // page was indexed with its text layer only, and the note says so.
    if (res.visionFailedPages.length > 0) {
      const n = res.visionFailedPages.length;
      const note = `${n} page${n === 1 ? "" : "s"} could not be read by AI vision` +
        (res.visionError ? ` (${res.visionError})` : "") +
        (res.legacy
          ? " — indexed with the text layer only: this database cannot hold them for a retry until migration 20261122 is applied."
          : " — retried automatically; the document is not marked ready until they are read or the partial index is accepted.");
      visionSkipReason = visionSkipReason ? `${visionSkipReason} ${note}` : note;
    }

    const visionCostUsd = visionUsage.inputTokens + visionUsage.outputTokens > 0
      ? estimateCostUsd(visionModel || vision!.model, visionUsage)
      : 0;
    if (res.visionRetryBlocked || res.failureRetryBlocked) {
      // Nothing failed now and nothing was lost: the reason is on the row
      // and here. A non-2xx stops the caller's loop with this message instead
      // of a misleading "stalled" one; the document keeps its status.
      return NextResponse.json({
        ...res, visionSkipReason, visionCostUsd, error: res.visionRetryMessage ?? res.failureRetryMessage,
      }, { status: 409 });
    }
    return NextResponse.json({ ...res, visionSkipReason, visionCostUsd });
  } catch (e) {
    const message = (e as Error).message;
    // Only onto the row the failing batch read: a batch a rev-up superseded
    // mid-flight never stamps anything on the new revision (ING-1). Under
    // the bound it is retried automatically (ING-8): `retryAfter` says when.
    const failed = await markIngestFailed({
      id: doc.id as string, file_key: doc.file_key as string, pages_indexed: (doc.pages_indexed as number | null) ?? 0,
      status: doc.status as string,
      ...("source_version_id" in doc ? { source_version_id: (doc.source_version_id as string | null) ?? null } : {}),
      ...("ingest_failures" in doc ? { ingest_failures: (doc.ingest_failures as number | null) ?? 0 } : {}),
    }, e);
    return NextResponse.json({ error: `Indexing failed: ${message}`, retryAfter: failed.retryAfter }, { status: 502 });
  }
}

/** The audit row for a document reaching 'ready'. (The Bridge and the
 *  mention pass run where the document becomes 'ready' — inside the engine
 *  for a batch, so the cron drain gets them too, and in acceptPartial below,
 *  both through onDocumentReady.) */
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
 *  listed on the row (vision_failed_pages) — the count stays visible.
 *
 *    - It takes the document's ingest claim like any writer, so a retry
 *      batch in flight can neither be overwritten by it nor undo it: the
 *      acceptance and the claim's release are one UPDATE.
 *    - The decision is audited FIRST, as a checked write naming the file it
 *      is about: an acceptance that cannot be recorded changes nothing.
 *    - The UPDATE is a compare-and-set on the row as claimed — its file,
 *      version and resume point. A rev-up may re-point the row even under
 *      this claim (ING-1), and accepting Rev 3's unread pages must never
 *      stamp Rev 4 'ready' with nothing indexed: that answers 409.
 *    - An accepted document feeds the Bridge and the mention pass exactly as
 *      one the engine completed (onDocumentReady). */
async function acceptPartial(doc: Record<string, unknown>, userId: string) {
  if (pageList(doc.vision_failed_pages).length === 0) return bad("Nothing to accept — no page is waiting on AI vision.", 409);
  const id = String(doc.id);
  const driver = `accept:${randomUUID()}`;
  let lease: Awaited<ReturnType<typeof claimIngestLease>>;
  try { lease = await claimIngestLease(id, driver); }
  catch (e) { return bad(`Could not accept the partial index: ${(e as Error).message}`, 500); }
  if (lease.kind === "gone") return bad("Document not found", 404);
  if (lease.kind === "busy") {
    return bad("This document is being indexed right now — try again in a moment.", 409);
  }
  // The row as claimed: the freshest page list and progress.
  const row = lease.kind === "claimed" ? lease.row : doc;
  const failed = pageList(row.vision_failed_pages);
  const refuse = async (msg: string, status = 409) => {
    if (lease.kind === "claimed") await releaseIngestLease(id, driver);
    return bad(msg, status);
  };
  // Already accepted (a double click, a client's retry): nothing to record
  // twice — no second audit row, no second Bridge pass.
  if (row.vision_partial_accepted === true || row.status === "ready") {
    return refuse("This partial index was already accepted — the document is ready.");
  }
  if (failed.length === 0) return refuse("Nothing to accept — no page is waiting on AI vision.");
  if (Number(row.pages_indexed ?? 0) < Number(row.page_count ?? Infinity)) {
    return refuse("Indexing has not reached the end of this document yet — let it finish first.");
  }
  const { error: auditErr } = await supabaseAdmin.from("audit_logs").insert({
    action: "KNOWLEDGE_DOC_PARTIAL_ACCEPTED",
    resource_type: "knowledge_document", resource_id: id,
    org_id: doc.org_id, user_id: userId,
    details: {
      name: doc.name, unreadPages: failed, fileKey: row.file_key,
      sourceVersionId: row.source_version_id ?? null, sourceRev: row.source_rev ?? null,
    },
  });
  if (auditErr) return refuse(`The acceptance could not be recorded, so nothing was changed: ${auditErr.message}`, 500);
  const known = new Set(Object.keys(row));
  const update = Object.fromEntries(Object.entries({
    vision_partial_accepted: true, status: "ready", error: null, vision_retry_after: null,
    vision_retry_tried: [], ingest_failures: 0,
    ingest_claimed_by: null, ingest_claimed_at: null,
  }).filter(([k]) => known.has(k)));
  let q = supabaseAdmin.from("knowledge_documents").update(update)
    .eq("id", id).eq("file_key", String(row.file_key)).eq("pages_indexed", Number(row.pages_indexed ?? 0));
  if ("source_version_id" in row) {
    q = row.source_version_id == null ? q.is("source_version_id", null) : q.eq("source_version_id", row.source_version_id as string);
  }
  if (lease.kind === "claimed") q = q.eq("ingest_claimed_by", driver);
  const { data, error } = await q.select("id");
  if (error) return refuse(`Could not accept the partial index: ${error.message}`, 500);
  if ((data ?? []).length === 0) {
    return refuse("The document changed while it was being accepted (a new revision, or indexing moved on) — reload and try again.");
  }
  await onIndexed(doc, userId, Number(row.page_count ?? 0), Number(row.vision_pages ?? 0));
  await onDocumentReady({
    id, org_id: String(doc.org_id),
    source_document_id: (row.source_document_id as string | null) ?? null,
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
