// lib/knowledgeIngest.ts — SERVER-ONLY. The one ingestion engine behind
// knowledge documents: download the PDF from R2, extract the next batch of
// pages with unpdf, chunk into knowledge_chunks, advance the document's
// progress counters. Used by BOTH doors:
//
//   - /api/knowledge/ingest — client-driven batches while someone watches
//   - /api/cron/maintenance — background drain of pending/stale documents
//     (linked doc-control sources index without anyone babysitting a tab)
//
// The loop is resumable by design: state lives on the knowledge_documents
// row (pages_indexed, last_section), so a timeout just picks up where the
// last batch stopped.
//
// ONE WRITER AT A TIME (ING-2 / ING-1, intelligence Round G). Three drivers
// reach this engine — the library page's loop, the app-shell indicator in
// every open tab, and the cron drain — and a rev-up re-points the row at a
// new file underneath them. Each batch therefore CLAIMS the document first
// (a conditional UPDATE on ingest_claimed_by / ingest_claimed_at, migration
// 20261122; a claim older than INGEST_LEASE_TTL_MS is free again, so a killed
// invocation never wedges a document), works from the row the claim
// returned, and commits with a compare-and-set on the claim, the file_key and
// source_version_id it read, and the pages_indexed it started from. A batch
// that loses that race withdraws the rows it wrote and reports `superseded`;
// a driver that finds the claim held reports `busy` — neither ever errors the
// document. The rev-up refresh takes the SAME claim through
// resetKnowledgeIndex below (the drawing rebuild is to take it too, once I-07
// moves app/api/knowledge/drawing/route.ts onto resetKnowledgeIndex; today it
// resets without it); a rev-up that finds a batch writing the OLD file does
// not wait for it — it re-points the row, and that batch's compare-and-set
// then misses and withdraws what it wrote. The claim lasts one batch, never a
// document, so the self-imposed deadline below still bounds everything.
//
// A batch that fails for real (ING-8) is retried AUTOMATICALLY, a bounded
// number of times: the failure is written on the row with a back-off
// (markIngestFailed), the document keeps its status — an 'indexing' document
// stays retrievable — and only after INGEST_FAILURE_MAX_ATTEMPTS failures in a
// row does it become 'error', for a person. Only a batch that did work clears
// the count; one that did nothing (it stopped before its first page, or a
// driver without an AI key parked it) leaves it, so the bound holds.

import { randomUUID } from "node:crypto";
import { GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { r2, R2_BUCKET } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { openAiKey } from "@/lib/ai/keyVault";
import { chunkPageText, splitPageIntoSections, ensurePdfPolyfills, CAPTION_RE,
  sanitizeStorageText, truncateSafe, splitTables, pageLinesFromTextItems, pageTail, carriedTailMarker,
  hasCarriedMarker, chunkerVersionOf, CHUNKER_LEGACY, CHUNKER_TABLE_AWARE, type ChunkerVersion, type PdfTextItem,
} from "@/lib/knowledgeText";
import {
  isDrawingLikePage, extractEquipmentTags, extractDrawingRefs, extractTitleBlock,
  parseOpcBoxes, pageNeedsVision, TEXTLESS_PAGE_MAX_CHARS, MIN_TAGS_THIN_PAGE,
} from "@/lib/drawingText";
import { transcribePageImage } from "@/lib/knowledgeVision";
import { isTimeoutError, type AiProviderId } from "@/lib/ai/providerCall";
import { ALLOWED_PROVIDERS, AGREEMENT_VERSION, type AiUsage } from "@/lib/ai/pricing";
import { getMonthUsage, getCapUsd, recordAskUsage } from "@/lib/ai/usageServer";
import { isAiUsageUnavailable } from "@/lib/ai/gateError";
import { loadOrgInstructionsBlock } from "@/lib/aiInstructionsServer";

export const PAGE_BATCH = 50;

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** Vision transcription context. Present only on the user-driven ingest
 *  path: transcription spends the TRIGGERING user's own key, so a
 *  background job never quietly bills someone. */
export interface VisionContext {
  provider: AiProviderId;
  model: string;
  apiKey: string;
  /** Max pages this invocation may transcribe (serverless time + cost). */
  budgetPages: number;
  /** Library option: read EVERY page with vision, not just unreadable ones
   *  (for drawing sets where even the text layer is unreliable). */
  forceAllPages?: boolean;
  /** Org Playbooks block appended to the transcription system prompt. */
  instructions?: string;
  onUsage: (usage: { inputTokens: number; outputTokens: number }, model: string) => void;
}

export interface IngestBatchResult {
  done: boolean;
  pageCount: number;
  /** Where the next batch starts — knowledge_documents.pages_indexed. The
   *  meaning this field has always had: clients detect a stall on it. A
   *  vision-retry batch (ING-6) does not move it — its progress is the fall
   *  in `visionFailedPages`, which a stall detector must count too. */
  pagesIndexed: number;
  /** The same resume point, named for what it is. */
  resumeAt: number;
  /** Pages the index holds a real read of: the resume point less the pages
   *  whose AI-vision read failed and waits for a retry (ING-6). */
  pagesReadable: number;
  /** Pages in THIS batch that yielded no text at all. */
  emptyPages: number;
  /** The document's running total of pages with no extractable text
   *  (knowledge_documents.empty_pages — ING-11). */
  emptyPagesTotal: number;
  /** Pages read by AI vision in this batch (no text layer). */
  visionPages: number;
  /** True when the batch stopped early because the vision budget ran out —
   *  the caller simply calls again to continue. */
  visionBudgetSpent: boolean;
  /** True when the batch stopped early because it was running out of
   *  invocation time. Progress up to the last finished page is committed;
   *  the caller just calls again. Not an error. */
  stoppedForTime: boolean;
  /** Pages whose vision read failed on a provider error and are queued for a
   *  retry; the document does not reach 'ready' while any remain (ING-6). */
  visionFailedPages: number[];
  /** The provider's message for the last failed vision read, if any. */
  visionError: string | null;
  /** Failed pages a vision-retry batch (ING-6) tried to read again, read or
   *  not. A retry batch that read none of them may still have moved on: the
   *  pages it tried go to the back of the queue, so the next batch tries the
   *  ones waiting longest. */
  visionRetryAttempts: number;
  /** Another driver holds this document's claim — nothing was done (ING-2). */
  busy: boolean;
  /** With `busy`: at most how long (ms) until that claim is free. A live
   *  batch lets go sooner; a claim an invocation the platform killed left
   *  behind frees itself only then (INGEST_LEASE_TTL_MS), so a caller that
   *  keeps finding the document busy is waiting, not stalled. */
  retryAfterMs: number | null;
  /** The row moved under this batch (re-pointed at a new revision, deleted,
   *  or the claim was lost): its writes were withdrawn (ING-1). */
  superseded: boolean;
  /** The failed vision pages could not be retried by this driver — no AI
   *  key, the provider refused every retry again, or an earlier refusal's
   *  back-off has not run out (ING-6). Nothing was lost: the document stays
   *  'indexing', retrievable, with `visionRetryMessage` on its row. */
  visionRetryBlocked: boolean;
  /** The plain-language reason, also written to the row's `error`. */
  visionRetryMessage: string | null;
  /** When the failed pages are next tried (ISO), when a back-off holds. */
  visionRetryAfter: string | null;
  /** An earlier batch of this document failed for real (ING-8) and is
   *  waiting out its back-off: nothing was done. The document keeps its
   *  index and its status; the failure is on its row (`error`), and any
   *  driver tries it again after `failureRetryAfter`. */
  failureRetryBlocked: boolean;
  failureRetryMessage: string | null;
  failureRetryAfter: string | null;
  /** A person's re-run (`retryNow`) was let through, but its record
   *  (`onRetryNow`) could not be written: nothing was run, and this says why. */
  retryNowError: string | null;
  /** The batch ran unclaimed, on a database without migration 20261122: no
   *  claim, and nowhere to hold a failed vision page for a retry (ING-6) —
   *  such a page is committed with its text layer only. */
  legacy: boolean;
  /** The stored file is not a PDF at all (ING-9): nothing was indexed; the
   *  caller refuses it through refuseNonPdf. */
  notPdf: SniffedKind | null;
  /** With `notPdf`: the file the check looked at — what the refusal
   *  compares against (refuseNonPdf's `read`). Server-side only. */
  notPdfRead?: IngestRead;
}

/** Time to leave on the clock before starting a vision page. Rendering a
 *  dense E-size drawing and transcribing it is tens of seconds, and a page
 *  begun too late is work the platform throws away. */
const VISION_PAGE_RESERVE_MS = 25_000;

type KnowledgeDocRow = {
  id: string;
  org_id: string;
  library_id: string;
  name: string;
  file_key: string;
  status: string;
  pages_indexed: number | null;
  page_count: number | null;
  last_section?: string | null;
  created_by?: string | null;
  /** The controlled version a mirror was re-pointed at (20260917). */
  source_version_id?: string | null;
  vision_pages?: number | null;
  /** 20261122: running counters and the vision retry queue. */
  empty_pages?: number | null;
  vision_failed_pages?: number[] | null;
  vision_partial_accepted?: boolean | null;
  /** Which chunker wrote this document's chunks (NULL = 1). */
  chunk_version?: number | null;
  /** Nothing waiting on this document is tried before this: failed vision
   *  pages after a refused retry pass (ING-6), or the next batch after a
   *  failed one (ING-8; a person's `retryNow` excepted). Also the document's
   *  place in the cron drain's queue, oldest first. */
  vision_retry_after?: string | null;
  /** Failed vision pages whose retry failed again since the last back-off —
   *  the current round (ING-6). */
  vision_retry_tried?: number[] | null;
  /** Failed batches in a row (ING-8); only a batch that did work zeroes it. */
  ingest_failures?: number | null;
  /** The controlled document a mirror reflects (for the mention pass). */
  source_document_id?: string | null;
  error?: string | null;
};

// ── The ingest claim (ING-2) ─────────────────────────────────────────────

/** How long a claim holds before another driver may take it over. Far
 *  longer than any invocation lives (60s interactive, the cron's drain is
 *  bounded to 40s), so a live batch never loses it; short enough that a
 *  batch the platform killed mid-flight frees the document within minutes. */
export const INGEST_LEASE_TTL_MS = 5 * 60_000;

type DbError = { code?: string; message?: string } | null | undefined;

/** A column the code writes is not in the database yet (a migration not
 *  applied): PostgREST's schema-cache miss or Postgres's own 42703. */
export const isMissingColumn = (e: DbError): boolean =>
  !!e && (e.code === "PGRST204" || e.code === "42703" ||
    /Could not find the '[^']+' column|column "?[\w.]+"? (of relation "?\w+"? )?does not exist/i.test(e.message ?? ""));

/** A table the code writes does not exist yet (a pre-migration database). */
export const isMissingTable = (e: DbError): boolean =>
  !!e && (e.code === "42P01" || e.code === "PGRST205" ||
    /relation "?[\w.]+"? does not exist|Could not find the table/i.test(e.message ?? ""));

export type IngestLease =
  | { kind: "claimed"; row: Record<string, unknown> }
  | { kind: "busy"; row: Record<string, unknown> }
  | { kind: "gone" }
  /** Pre-20261122 database (no claim columns): the legacy, unclaimed path. */
  | { kind: "unlocked" };

/** Claim a knowledge document for ONE batch of work. A single conditional
 *  UPDATE — Postgres re-evaluates the WHERE on the row it locks, so of two
 *  drivers racing, exactly one sees the claim free. Returns the whole row as
 *  claimed (the freshest pages_indexed / file_key / counters), the row held
 *  by someone else, or `gone` when the document no longer exists. */
export async function claimIngestLease(
  documentId: string, driver: string, nowMs: number = Date.now(),
): Promise<IngestLease> {
  const now = new Date(nowMs).toISOString();
  const cutoff = new Date(nowMs - INGEST_LEASE_TTL_MS).toISOString();
  const { data, error } = await supabaseAdmin.from("knowledge_documents")
    .update({ ingest_claimed_by: driver, ingest_claimed_at: now })
    .eq("id", documentId)
    .or(`ingest_claimed_at.is.null,ingest_claimed_at.lt."${cutoff}"`)
    .select("*");
  if (error) {
    if (isMissingColumn(error)) return { kind: "unlocked" };
    throw new Error(`ingest claim failed: ${error.message}`);
  }
  const row = ((data ?? []) as Array<Record<string, unknown>>)[0];
  if (row) return { kind: "claimed", row };
  const { data: held, error: readErr } = await supabaseAdmin
    .from("knowledge_documents").select("*").eq("id", documentId).maybeSingle();
  if (readErr) throw new Error(`ingest claim failed: ${readErr.message}`);
  if (!held) return { kind: "gone" };
  return { kind: "busy", row: held as Record<string, unknown> };
}

/** Give a claim back. Only the driver that holds it can release it; a
 *  release that fails is harmless — the TTL frees the document. */
export async function releaseIngestLease(documentId: string, driver: string): Promise<boolean> {
  const { error } = await supabaseAdmin.from("knowledge_documents")
    .update({ ingest_claimed_by: null, ingest_claimed_at: null })
    .eq("id", documentId).eq("ingest_claimed_by", driver);
  return !error;
}

/** A page list, in queue order (duplicates and junk dropped). The order of
 *  vision_failed_pages is the retry queue: least recently tried first. */
const pageQueue = (v: unknown): number[] =>
  Array.isArray(v) ? [...new Set(v.map(Number).filter((n) => Number.isInteger(n) && n > 0))] : [];
/** The same pages in page order — what a person reads. */
const pageList = (v: unknown): number[] => pageQueue(v).sort((a, b) => a - b);

/** The columns 20261122 adds to knowledge_documents — stripped from a write
 *  on a database that has not applied it yet. */
const INGEST_COLUMNS_20261122 = [
  "ingest_claimed_by", "ingest_claimed_at", "empty_pages", "vision_failed_pages",
  "vision_partial_accepted", "chunk_version", "vision_retry_after", "vision_retry_tried",
  "ingest_failures",
];

// ── The shared reset (ING-3 / DWG-1 / ING-12) ─────────────────────────────

export interface KnowledgeIndexReset {
  /** Documents whose derived index is gone and that are queued ('stale'). */
  reset: string[];
  /** Documents left untouched: another driver was indexing them at that
   *  moment (a later pass resets them), or — with `expect` — the row no
   *  longer says what the caller read (another writer moved it first; the
   *  caller's view is stale and a later pass reconciles from the row). */
  busy: string[];
  errors: string[];
}

/** Everything the index derives from a file, zeroed: the row says "nothing
 *  read yet" and every counter starts again for the new index generation. */
const RESET_ROW = {
  status: "stale", error: null, pages_indexed: 0, page_count: null, last_section: null,
  vision_pages: 0, empty_pages: 0, vision_failed_pages: [] as number[],
  vision_partial_accepted: false, chunk_version: null, vision_retry_after: null,
  vision_retry_tried: [] as number[], ingest_failures: 0,
};

/** THE reset of a knowledge document's derived index — the one the rev-up
 *  refresh (lib/knowledgeSourceSync.ts) and the library re-index call, and
 *  the drawing intelligence "Rebuild index" is to call once I-07 moves
 *  app/api/knowledge/drawing/route.ts onto it (today that rebuild resets
 *  without the claim), so none can forget a table again.
 *  Under the document's ingest claim, in order:
 *
 *    1. on a rev-up (`purgeLineTraces`), the cached line traces drawn over
 *       the old sheet — a pure cache, dropped while the row still names the
 *       old file, so a failure here leaves everything as it was and the
 *       next pass repeats the whole reset;
 *    2. THE ROW, before any derived row goes: 'stale', counters to zero
 *       (vision_pages included — ING-12), plus `rowUpdate` (the rev-up's new
 *       file_key / version / rev). An interrupted reset therefore leaves a
 *       queued row, never a 'ready' one whose chunks are gone;
 *    3. every chunk (and with it the chunk's embedding), every page entity
 *       (tags, refs, sheet identity, anchors, vision positions) and the
 *       MACHINE-derived entity mentions (a person's explicit pin survives —
 *       a re-index is not a decision). A delete that fails here is reported,
 *       and is not lost: the row is already queued, and the first batch of
 *       the new index generation clears every chunk and page entity of the
 *       document before it writes (ingestKnowledgeDocBatch), while the
 *       mention pass replaces the machine mentions when it reaches 'ready'.
 *
 *  A document another driver is indexing at that moment is reported `busy`
 *  and left alone — unless `supersedeBusy` (the rev-up): a batch writing the
 *  OLD file must not keep serving it until the next pass, and it need not be
 *  waited for, because re-pointing the row makes its compare-and-set miss
 *  (it withdraws what it wrote). That re-point is itself a compare-and-set
 *  on the file and version the row named. A same-file reset (a rebuild, a
 *  library re-index) cannot be seen by the compare-and-set of a batch that
 *  started at page 0, so it always waits its turn.
 *
 *  `expect` is what the CALLER read the row as (the rev-up passes the
 *  version it saw). The reset happens only while the row still says that,
 *  checked before anything is deleted and compared again by the row's own
 *  UPDATE on every path, claimed or superseding. A second sync that read the
 *  mirror before the first one re-pointed it would otherwise supersede the
 *  NEW revision's own first batch — whose commit would still match — and
 *  leave the document 'ready' with no chunks; or re-reset a partly
 *  re-indexed new revision and re-bill its vision pages (ING-1). Such a row
 *  is reported `busy` and left exactly as it is. */
export async function resetKnowledgeIndex(
  documentIds: string[],
  opts: {
    rowUpdate?: (documentId: string) => Record<string, unknown>;
    /** The file changed (rev-up): cached traces of the old sheet go too. */
    purgeLineTraces?: boolean;
    /** The file changed (rev-up): re-point the row even under a running
     *  batch, whose commit then misses and withdraws (ING-1). */
    supersedeBusy?: boolean;
    /** Columns the row must still hold, as the caller read them (e.g.
     *  `{ source_version_id }`); a row that moved is left alone (`busy`). */
    expect?: (documentId: string) => Record<string, unknown>;
  } = {},
): Promise<KnowledgeIndexReset> {
  const out: KnowledgeIndexReset = { reset: [], busy: [], errors: [] };
  for (const id of documentIds) {
    const want = Object.entries(opts.expect?.(id) ?? {});
    /** The row no longer says what the caller read. */
    const drifted = (row: Record<string, unknown>) =>
      want.some(([k, v]) => k in row && (row[k] ?? null) !== (v ?? null));
    /** The caller's reading, compared by the UPDATE itself (columns the
     *  database has — `row` is a full row as read). */
    const expectOn = <Q extends { eq: (c: string, v: unknown) => Q; is: (c: string, v: null) => Q }>(q: Q, row: Record<string, unknown> | null): Q => {
      let o = q;
      for (const [k, v] of want) {
        if (!row || !(k in row)) continue;
        o = v == null ? o.is(k, null) : o.eq(k, v);
      }
      return o;
    };
    const driver = `reset:${randomUUID()}`;
    let lease: IngestLease;
    try {
      lease = await claimIngestLease(id, driver);
    } catch (e) {
      out.errors.push(`${id}: ${(e as Error).message}`);
      continue;
    }
    if (lease.kind === "gone") continue;
    const held = lease.kind === "claimed";
    const seen = lease.kind === "claimed" || lease.kind === "busy" ? lease.row : null;
    const release = async () => { if (held) await releaseIngestLease(id, driver); };
    // Pre-20261122 (no claim, no row back): read the row to compare.
    let probe: Record<string, unknown> | null = null;
    if (!seen && want.length > 0) {
      const { data, error } = await supabaseAdmin.from("knowledge_documents").select("*").eq("id", id).maybeSingle();
      if (error) { out.errors.push(`${id}: ${error.message}`); continue; }
      if (!data) continue;
      probe = data as Record<string, unknown>;
    }
    // Moved since the caller read it: not this reset's to touch — before
    // anything, line traces included, is deleted.
    if ((seen && drifted(seen)) || (probe && drifted(probe))) {
      await release();
      out.busy.push(id);
      continue;
    }
    if (lease.kind === "busy" && !opts.supersedeBusy) { out.busy.push(id); continue; }

    // 1. The old sheet's cached traces (rev-up only), while the row still
    //    names the old file.
    if (opts.purgeLineTraces) {
      const { error: trErr } = await supabaseAdmin
        .from("knowledge_line_traces").delete().eq("document_id", id);
      if (trErr && !isMissingTable(trErr)) {
        out.errors.push(`${id}: line traces: ${trErr.message}`);
        await release();
        continue;
      }
    }

    // 2. The row: queued and zeroed (and re-pointed) FIRST. Under our own
    //    claim the claim is kept through the deletes; under someone else's
    //    (supersedeBusy) theirs is left exactly as it is.
    const full: Record<string, unknown> = { ...RESET_ROW, ...(opts.rowUpdate?.(id) ?? {}) };
    let updErr: DbError = null;
    let wrote = 0;
    if (seen) {
      const known = new Set(Object.keys(seen));
      const update = Object.fromEntries(Object.entries(full).filter(([k]) => known.has(k)));
      let q = supabaseAdmin.from("knowledge_documents").update(update).eq("id", id);
      if (held) {
        q = q.eq("ingest_claimed_by", driver);
      } else {
        // The row as we saw it — a concurrent sync that already re-pointed it
        // wins, and this pass leaves it alone.
        q = q.eq("file_key", String(seen.file_key));
        if ("source_version_id" in seen) {
          q = seen.source_version_id == null ? q.is("source_version_id", null) : q.eq("source_version_id", seen.source_version_id);
        }
      }
      // …and, on every path, still what the caller read.
      q = expectOn(q, seen);
      const { data, error } = await q.select("id");
      updErr = error; wrote = (data ?? []).length;
    } else {
      // Pre-20261122: no claim, no new counters. Strip what the database
      // does not have yet, newest first.
      const ladder = [
        full,
        Object.fromEntries(Object.entries(full).filter(([k]) => !INGEST_COLUMNS_20261122.includes(k))),
        Object.fromEntries(Object.entries(full).filter(([k]) =>
          !INGEST_COLUMNS_20261122.includes(k) && k !== "vision_pages" && k !== "last_section")),
      ];
      for (const update of ladder) {
        const { data, error } = await expectOn(supabaseAdmin.from("knowledge_documents")
          .update(update).eq("id", id), probe).select("id");
        updErr = error; wrote = (data ?? []).length;
        if (!error || !isMissingColumn(error)) break;
      }
    }
    if (updErr) { out.errors.push(`${id}: row: ${updErr.message}`); await release(); continue; }
    if (wrote === 0) {
      // Someone else moved it first (re-pointed it, or — under an `expect` —
      // it no longer says what the caller read): left alone.
      if (held && want.length === 0) out.errors.push(`${id}: row: the claim was lost before the reset committed`);
      else out.busy.push(id);
      await release();
      continue;
    }

    // 3. The derived index. Each step checked; a failure is reported and
    //    the next generation's first batch clears what is left.
    const left: string[] = [];
    const { error: chunkErr } = await supabaseAdmin
      .from("knowledge_chunks").delete().eq("document_id", id);
    if (chunkErr) left.push(`chunks: ${chunkErr.message}`);
    const { error: entErr } = await supabaseAdmin
      .from("knowledge_page_entities").delete().eq("document_id", id);
    if (entErr && !isMissingTable(entErr)) left.push(`page entities: ${entErr.message}`);
    const { error: menErr } = await supabaseAdmin
      .from("entity_mentions").delete().eq("knowledge_document_id", id).eq("is_explicit", false);
    if (menErr && !isMissingTable(menErr)) left.push(`mentions: ${menErr.message}`);
    await release();
    out.reset.push(id);
    if (left.length > 0) {
      out.errors.push(`${id}: ${left.join("; ")} (the row is queued; the re-index's first batch clears what is left)`);
    }
  }
  return out;
}

// ── What the stored file actually is (ING-9) ──────────────────────────────

export type SniffedKind = "pdf" | "office" | "text" | "image" | "unknown";

/** Classify a file by its leading bytes. PDF: "%PDF-" in the first 1,024
 *  bytes (the spec's allowance for leading junk). Office: the ZIP container
 *  of .xlsx/.docx or the OLE container of .xls/.doc. Pure. */
export function sniffBytes(head: Uint8Array): SniffedKind {
  const at = (sig: number[], off = 0) => sig.every((b, i) => head[off + i] === b);
  const ascii = String.fromCharCode(...head.subarray(0, 1024));
  if (ascii.includes("%PDF-")) return "pdf";
  if (at([0x50, 0x4b, 0x03, 0x04]) || at([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "office";
  if (at([0x89, 0x50, 0x4e, 0x47]) || at([0xff, 0xd8, 0xff]) || at([0x49, 0x49, 0x2a, 0x00]) || at([0x4d, 0x4d, 0x00, 0x2a])) return "image";
  const sample = head.subarray(0, 512);
  if (sample.length > 0) {
    let printable = 0;
    for (const b of sample) if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 0x80) printable++;
    if (printable / sample.length > 0.95) return "text";
  }
  return "unknown";
}

/** Read only the first KB of a stored object (a ranged GET) and classify it
 *  — before the whole file is downloaded and handed to pdf.js. */
export async function sniffStoredFile(fileKey: string): Promise<SniffedKind> {
  const obj = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: fileKey, Range: "bytes=0-1023" }));
  const head = new Uint8Array(await new Response(obj.Body as ReadableStream).arrayBuffer());
  return sniffBytes(head.subarray(0, 1024));
}

/** The plain-language refusal for a non-PDF, naming where the file belongs.
 *  An equipment list goes to the registry's importer, which takes
 *  spreadsheets (components/assets/AssetCsvImportModal.tsx). */
export function notPdfMessage(name: string, kind: SniffedKind): string {
  const head = `Only PDF files can be indexed — "${name}" is not a PDF`;
  switch (kind) {
    case "office":
    case "text":
      return `${head} (it looks like ${kind === "office" ? "an Excel or Word file" : "a text or CSV file"}). ` +
        "To load an equipment list, open Operating areas and use Import CSV — it takes .xlsx, .xls and .csv. " +
        "For a document, save it as PDF and add it again.";
    case "image":
      return `${head} (it looks like an image). Save or scan it to PDF, then add it again.`;
    default:
      return `${head}. Save it as PDF, then add it again.`;
  }
}

/** What a batch read: the file, the version and the resume point. A writer
 *  that records something about that batch on the document (a failure, a
 *  refusal) compares against it, so it lands only on the row the batch read
 *  — never on a row a rev-up re-pointed at a new revision since (ING-1). */
export interface IngestRead {
  fileKey: string;
  /** Absent when the row carries no such column (a pre-20260917 database). */
  sourceVersionId?: string | null;
  pagesIndexed: number;
  /** The row's status as read. */
  status?: string;
  /** Failed batches in a row as read (ING-8); absent on a database without
   *  20261122, which has nowhere to count them. */
  failures?: number;
}

type ReadableRow = {
  file_key: string; source_version_id?: string | null; pages_indexed?: number | null;
  status?: string | null; ingest_failures?: number | null;
};
const readOf = (row: ReadableRow): IngestRead => ({
  fileKey: row.file_key,
  pagesIndexed: Number(row.pages_indexed ?? 0),
  ...(row.source_version_id !== undefined ? { sourceVersionId: row.source_version_id ?? null } : {}),
  ...(typeof row.status === "string" ? { status: row.status } : {}),
  ...("ingest_failures" in row ? { failures: Number(row.ingest_failures ?? 0) } : {}),
});

/** THE refusal of a stored file that is not a PDF — one rule for both
 *  drivers that can meet it first (the interactive route and the cron
 *  drain). An UPLOAD (no source, its key under the org's knowledge prefix)
 *  leaves nothing behind: the refusal is audited FIRST — one that cannot be
 *  recorded destroys nothing — then its row and its R2 object go. A MIRRORED
 *  controlled file is never deleted — the object is doc control's — so its
 *  row is marked 'error' with the same plain message. Both writes compare
 *  against `read`, the file the sniff looked at: a row a rev-up re-pointed
 *  meanwhile is left alone (`superseded`). `actorUserId` is null when the
 *  cron met it. */
export async function refuseNonPdf(
  row: Record<string, unknown>, kind: SniffedKind, actorUserId: string | null, read?: IngestRead,
): Promise<{ message: string; removed: boolean; superseded: boolean; error: string | null }> {
  const id = String(row.id);
  const message = notPdfMessage(String(row.name ?? "This file"), kind);
  const fileKey = read?.fileKey ?? String(row.file_key ?? "");
  const version: string | null | undefined = read
    ? read.sourceVersionId
    : "source_version_id" in row ? ((row.source_version_id as string | null) ?? null) : undefined;
  const uploaded = !row.source_document_id && !row.source_id &&
    fileKey.startsWith(`orgs/${String(row.org_id)}/knowledge/`);
  if (uploaded) {
    const { error: auditErr } = await supabaseAdmin.from("audit_logs").insert({
      action: "KNOWLEDGE_DOC_REJECTED",
      resource_type: "knowledge_document", resource_id: id,
      org_id: row.org_id, user_id: actorUserId,
      details: { name: row.name, fileKey, detected: kind, reason: "not a PDF", by: actorUserId ? "ingest" : "maintenance" },
    });
    if (auditErr) {
      return { message, removed: false, superseded: false, error: `The refusal could not be recorded, so the upload was kept: ${auditErr.message}` };
    }
    let del = supabaseAdmin.from("knowledge_documents").delete().eq("id", id).eq("file_key", fileKey);
    if (version !== undefined) del = version === null ? del.is("source_version_id", null) : del.eq("source_version_id", version);
    const { data: gone, error: delErr } = await del.select("id");
    if (delErr) return { message, removed: false, superseded: false, error: `The upload could not be removed: ${delErr.message}` };
    if ((gone ?? []).length === 0) return { message, removed: false, superseded: true, error: null };
    await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: fileKey }))
      .catch(() => undefined); // the orphan sweeper reclaims an object whose delete failed
    return { message, removed: true, superseded: false, error: null };
  }
  let mark = supabaseAdmin.from("knowledge_documents")
    .update({ status: "error", error: truncateSafe(message, ERROR_MAX_CHARS) }).eq("id", id).eq("file_key", fileKey);
  if (version !== undefined) mark = version === null ? mark.is("source_version_id", null) : mark.eq("source_version_id", version);
  const { data: marked, error: markErr } = await mark.select("id");
  if (markErr) return { message, removed: false, superseded: false, error: markErr.message };
  return { message, removed: false, superseded: (marked ?? []).length === 0, error: null };
}

/** A batch that failed for real — carrying what it read, so the caller that
 *  records the failure writes it only onto that row (`markIngestFailed`).
 *  `permanent`: retrying cannot help (the stored file is a damaged PDF), so
 *  the document goes straight to 'error'. */
export class IngestBatchError extends Error {
  constructor(message: string, readonly read: IngestRead, readonly permanent = false) {
    super(message);
    this.name = "IngestBatchError";
  }
}

/** Failed batches in a row that are retried automatically (ING-8). The
 *  bound is on re-billing: a batch that fails after its page loop has read
 *  up to its vision budget, and each retry reads those pages again — so at
 *  most this many times, then the document is 'error' and a person decides.
 *  "In a row" means with no work in between: the count is cleared only by a
 *  batch that read a page, tried a vision retry or finished the document
 *  (its commit, or a retry pass's park) — never by one that stopped before
 *  its first page, nor by a driver without an AI key parking the document. */
export const INGEST_FAILURE_MAX_ATTEMPTS = 3;

/** Where the next automatic attempt comes from: nothing runs on a timer.
 *  An open app tab of an Admin or Doc Control member drives indexing every
 *  two minutes; otherwise the maintenance cron's drain runs once a day
 *  (vercel.json, 03:00 UTC). */
const NEXT_INDEXING_PASS =
  "on the next indexing pass (while an Admin or Doc Control member has the app open, or the nightly maintenance run where the library can be indexed unattended)";

/** How long a failed batch waits before any driver may try it again: ten
 *  minutes after the first failure, thirty after the second. Long enough
 *  that the app-shell indicator (every open tab, every two minutes) and the
 *  library page cannot hot-retry a failure. It is a floor, not a schedule:
 *  the retry comes on the next indexing pass after it — within minutes while
 *  a controller has the app open, otherwise the nightly maintenance run, so
 *  a failure no one is watching is next tried the following night, and its
 *  third attempt (the move to 'error') comes about two days after the first. */
export const ingestFailureBackoffMs = (attempt: number): number =>
  10 * 60_000 * 3 ** Math.max(0, attempt - 1);

/** The longest message a document row's `error` is given. */
const ERROR_MAX_CHARS = 500;

/** A cause cut to `room` characters (surrogate-safe, marked "…"), so the
 *  sentences written around it — the attempt count, when it is tried again —
 *  always fit in the row's `error`: a long cause loses its own end, never
 *  what the person is told to expect. */
function fitCause(cause: string, room: number): string {
  const n = Math.max(1, room);
  return cause.length > n ? truncateSafe(cause, n - 1) + "…" : cause;
}

/** A cause and the sentence that follows it, within ERROR_MAX_CHARS. */
const causeThen = (cause: string, tail: string): string => fitCause(cause, ERROR_MAX_CHARS - tail.length) + tail;

/** What names a retried failure's attempt in its message. failureBackoffUntil
 *  matches it, so a back-off holds only while the row still carries the
 *  message written for its count. */
const attemptMarker = (attempt: number): string => ` — attempt ${attempt} of ${INGEST_FAILURE_MAX_ATTEMPTS}.`;

/** The plain-language record of a failed batch that will be retried. The
 *  attempt count and the cadence come after the cause and always survive:
 *  the cause is cut to fit (ERROR_MAX_CHARS), never they. */
export function ingestFailureMessage(cause: string, attempt: number, retryAfterMs: number, searchable: boolean): string {
  const mins = Math.max(1, Math.round(retryAfterMs / 60_000));
  const tail = `${attemptMarker(attempt)} ` +
    `Indexing is tried again automatically ${NEXT_INDEXING_PASS}, no sooner than about ${mins} minutes from now.` +
    (searchable ? " The pages indexed so far stay searchable meanwhile." : "");
  return causeThen(cause, tail);
}

/** When a failed batch's back-off (ING-8) still holds this document back:
 *  the time it lapses, or null. It holds only while the row carries the
 *  failure's record — the count AND the message markIngestFailed wrote for
 *  that count (it names the attempt). A writer that cleared the message
 *  without the count (the drawing rebuild's own reset, until I-07 moves it
 *  onto resetKnowledgeIndex, which zeroes both) releases it. So does a
 *  vision-retry park that kept the count (it read nothing) but wrote its
 *  own reason and back-off over the failure's (ING-6): that stamp is the
 *  vision retry's, and it is reported, and held, as one. */
export function failureBackoffUntil(
  row: { ingest_failures?: unknown; error?: unknown; vision_retry_after?: unknown },
  nowMs: number = Date.now(),
): string | null {
  const failures = Number(row.ingest_failures ?? 0);
  if (!(failures > 0) || typeof row.error !== "string" || !row.error.includes(attemptMarker(failures))) return null;
  const after = Date.parse(String(row.vision_retry_after ?? ""));
  return Number.isFinite(after) && after > nowMs ? String(row.vision_retry_after) : null;
}

/** Record a failed batch on its document — the route's and the cron drain's
 *  one failure write (ING-8).
 *
 *    - Under the bound (INGEST_FAILURE_MAX_ATTEMPTS failures in a row), the
 *      failure is RETRIED AUTOMATICALLY: the row keeps a queued status — an
 *      'indexing' document (pages already indexed) stays 'indexing', so it
 *      stays in Ask; one with nothing indexed yet stays 'pending' / 'stale'
 *      — and carries the message, the count (`ingest_failures`) and a back-off
 *      (`vision_retry_after`, ingestFailureBackoffMs) that every driver
 *      honours before it tries the document again (failureBackoffUntil) —
 *      except a person's explicit re-run (`retryNow`). A batch that did work
 *      clears all three; one that did nothing leaves them.
 *    - At the bound, for a failure retrying cannot mend (a damaged PDF), or
 *      on a database without 20261122 (nowhere to count): `status: 'error'`
 *      with the message, for a person to re-run. That takes the whole
 *      document out of Ask until they do — accepted (DEC-58 item 3): the
 *      library page shows an 'error' row's message and re-runs it, and it
 *      cannot yet show one on an 'indexing' row or tell its Resume from the
 *      automatic loops.
 *
 *  It is a compare-and-set on what the batch read (the file, the version,
 *  the resume point and the failure count; the caller's copy when the batch
 *  never got as far as reading the row), so a batch a rev-up superseded mid-
 *  flight can never stamp its failure onto the re-pointed revision (ING-1),
 *  and two failures cannot count as one. `marked` is false when the row had
 *  moved and was left alone; `retryAfter` says when it is tried again. */
export async function markIngestFailed(
  doc: ReadableRow & { id: string },
  e: unknown,
  nowMs: number = Date.now(),
): Promise<{ marked: boolean; retryAfter: string | null; error: string | null }> {
  const cause = (e instanceof Error ? e.message : String(e));
  const read = e instanceof IngestBatchError ? e.read : readOf(doc);
  const permanent = e instanceof IngestBatchError && e.permanent;
  const attempt = (read.failures ?? 0) + 1;
  const retry = read.failures !== undefined && !permanent && attempt < INGEST_FAILURE_MAX_ATTEMPTS;
  const wait = ingestFailureBackoffMs(attempt);
  const retryAfter = retry ? new Date(nowMs + wait).toISOString() : null;
  // Every message is fitted surrogate-safe: a cut through a pair leaves a
  // lone surrogate, which Postgres refuses in the JSON body — the failure
  // would then never be recorded, and every driver would retry it unbounded.
  const legacyUpdate = { status: "error", error: fitCause(cause, ERROR_MAX_CHARS) };
  const update: Record<string, unknown> = read.failures === undefined ? legacyUpdate
    : retry
      ? {
        // A queued status, never 'error': an 'indexing' document stays in
        // Ask; one with nothing indexed yet stays out of it.
        status: read.pagesIndexed > 0 ? "indexing" : read.status === "stale" ? "stale" : "pending",
        error: ingestFailureMessage(cause, attempt, wait, read.pagesIndexed > 0),
        ingest_failures: attempt, vision_retry_after: retryAfter,
      }
      : {
        ...legacyUpdate,
        error: attempt >= INGEST_FAILURE_MAX_ATTEMPTS && !permanent
          ? causeThen(cause, ` — indexing failed ${attempt} times in a row; re-run it once the cause is fixed.`)
          : fitCause(cause, ERROR_MAX_CHARS),
        ingest_failures: attempt, vision_retry_after: null,
      };
  const write = (patch: Record<string, unknown>, withCount: boolean) => {
    let q = supabaseAdmin.from("knowledge_documents").update(patch)
      .eq("id", doc.id).eq("file_key", read.fileKey).eq("pages_indexed", read.pagesIndexed);
    if (read.sourceVersionId !== undefined) {
      q = read.sourceVersionId === null ? q.is("source_version_id", null) : q.eq("source_version_id", read.sourceVersionId);
    }
    if (withCount && read.failures !== undefined) q = q.eq("ingest_failures", read.failures);
    return q.select("id");
  };
  let { data, error } = await write(update, true);
  if (error && isMissingColumn(error)) ({ data, error } = await write(legacyUpdate, false));
  const marked = !error && (data ?? []).length > 0;
  return { marked, retryAfter: marked ? retryAfter : null, error: error ? error.message : null };
}

// ── Re-index a library with a chosen chunker (ING-4 / ING-7) ──────────────

export interface LibraryReindex extends KnowledgeIndexReset {
  chunker: ChunkerVersion;
  /** Nothing was changed: the numbers below are what a real run would do. */
  dryRun: boolean;
  /** Documents in the library. */
  documents: number;
  /** Documents the re-index resets: every one holding an index written by
   *  the OTHER chunker. A document already on the chosen chunker, or with
   *  nothing indexed yet (its first batch takes the library's choice), is
   *  skipped — so running the action again resumes it, and never resets a
   *  document twice. */
  toReset: number;
  /** AI-vision pages those documents hold — read (and billed) again by the
   *  re-index. A dry run reports it before anything is deleted. */
  visionPagesToReread: number;
  /** Documents still to reset after this call — not reached before the
   *  deadline, busy, or failed. Run the action again to continue. */
  remaining: number;
}

/** The explicit per-library switch between chunkers. Never run
 *  automatically — every chunk boundary in the library changes, and vision-
 *  read pages are read (and billed) again — so a `dryRun` answers first,
 *  changing nothing: how many documents would reset and how many vision
 *  pages they would re-read. A real run records the library's choice, then
 *  resets each document that needs it through the shared reset, one at a
 *  time, until `deadlineMs`; each re-indexes from its first page under the
 *  new chunker. The meaning (embedding) index follows the new chunks as its
 *  own pipeline re-embeds them. */
export async function reindexLibraryChunks(
  libraryId: string, chunker: ChunkerVersion,
  opts: { dryRun?: boolean; deadlineMs?: number } = {},
): Promise<LibraryReindex> {
  const needsMigration = "Choosing a chunker needs migration 20261122_intel_roundG_ingest_integrity.sql — apply it first.";
  const docs: Array<{ id: string; vision_pages: number | null; chunk_version: number | null; pages_indexed: number | null }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin.from("knowledge_documents")
      .select("id, vision_pages, chunk_version, pages_indexed").eq("library_id", libraryId)
      .order("id", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(isMissingColumn(error) ? needsMigration : `documents: ${error.message}`);
    const page = (data ?? []) as typeof docs;
    docs.push(...page);
    if (page.length < 1000) break;
  }
  const todo = docs.filter((d) => Number(d.pages_indexed ?? 0) > 0 && chunkerVersionOf(d.chunk_version) !== chunker);
  const visionPagesToReread = todo.reduce((n, d) => n + Number(d.vision_pages ?? 0), 0);
  const out: LibraryReindex = {
    reset: [], busy: [], errors: [], chunker, dryRun: opts.dryRun === true,
    documents: docs.length, toReset: todo.length, visionPagesToReread, remaining: todo.length,
  };
  if (opts.dryRun) {
    const { error } = await supabaseAdmin.from("knowledge_libraries").select("chunk_version").eq("id", libraryId).maybeSingle();
    if (error) throw new Error(isMissingColumn(error) ? needsMigration : `library: ${error.message}`);
    return out;
  }

  // The library's choice first: a document reset below re-indexes under it.
  const { error: libErr } = await supabaseAdmin
    .from("knowledge_libraries").update({ chunk_version: chunker }).eq("id", libraryId);
  if (libErr) throw new Error(isMissingColumn(libErr) ? needsMigration : `library: ${libErr.message}`);
  for (const d of todo) {
    if (opts.deadlineMs && Date.now() >= opts.deadlineMs) break;
    const res = await resetKnowledgeIndex([d.id]);
    out.reset.push(...res.reset);
    out.busy.push(...res.busy);
    out.errors.push(...res.errors);
  }
  out.remaining = todo.length - out.reset.length;
  return out;
}

/** Thrown inside a batch when its writes collide with another writer's
 *  (duplicate chunk key, the document row deleted underneath it): the batch
 *  withdraws what it wrote and reports `superseded` rather than erroring
 *  the document (ING-2 criterion 3). */
class IngestSuperseded extends Error {}

/** How long failed vision pages wait after a retry pass in which the
 *  provider refused every one of them again (ING-6). A provider that is
 *  rate-limiting or overloaded is not asked again on the very next batch —
 *  by any driver — and the rest of the document stays searchable meanwhile.
 *  A floor, like ingestFailureBackoffMs: the retry comes on the next
 *  indexing pass after it. */
export const VISION_RETRY_BACKOFF_MS = 30 * 60_000;

/** The plain-language reason failed vision pages were not retried. It
 *  offers only what a person can do from the app today: the acceptance of a
 *  partial index has no button yet (I-02's library page), so it is named as
 *  something to ask an admin for, not an action. The provider's message is
 *  cut to fit the row's `error` (ERROR_MAX_CHARS), never the cadence or the
 *  way out that follow it. */
export function visionRetryMessage(pages: number[], cause: string | null): string {
  const list = pages.slice(0, 12).join(", ") + (pages.length > 12 ? ", …" : "");
  const what = `AI vision could not read ${pages.length} page${pages.length === 1 ? "" : "s"} (p. ${list})`;
  const meanwhile = "The rest of the document is searchable meanwhile.";
  if (!cause) {
    return `${what}, and retrying needs an AI key with budget left. ${meanwhile} Add one in AI settings and re-run indexing, or ask an admin to accept the partial index.`;
  }
  const head = `${what}: `;
  const rest = `. They are tried again automatically ${NEXT_INDEXING_PASS}, no sooner than about ${Math.round(VISION_RETRY_BACKOFF_MS / 60_000)} minutes from now. ${meanwhile} If they stay unreadable, ask an admin to accept the partial index.`;
  return head + fitCause(cause, ERROR_MAX_CHARS - head.length - rest.length) + rest;
}

/** Everything that follows a document reaching 'ready': the mention pass
 *  that draws its document↔equipment edges on the graph. Every reset drops
 *  a document's machine mentions, so they are rebuilt wherever it becomes
 *  'ready' again — the interactive route, the cron drain, an accepted
 *  partial index. Best-effort with a hard time cap: a slow scan never fails
 *  or stalls ingestion. */
export async function rebuildDocumentMentions(
  doc: { id: string; org_id: string; source_document_id?: string | null },
  capMs = 8_000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { loadAliasDictionary, indexDocumentMentions } = await import("@/lib/mentionIndexer");
    const dict = await loadAliasDictionary(doc.org_id);
    if (dict.length === 0) return;
    await Promise.race([
      indexDocumentMentions(doc.org_id, doc.id, dict, doc.source_document_id ?? null),
      new Promise((r) => { timer = setTimeout(r, capMs); }),
    ]);
  } catch { /* mention edges are a bonus — never block ingestion */ }
  finally { if (timer) clearTimeout(timer); }
}

/** Everything that follows a document reaching 'ready', wherever it gets
 *  there — a batch's commit on either door, or an accepted partial index:
 *  the drawing→equipment Bridge (freshly extracted tags flow toward the
 *  source document's equipment column and the registry; fire-and-forget and
 *  dynamically imported, so a Bridge failure can never break indexing), and
 *  the mention pass the reset that queued this index generation dropped. */
export async function onDocumentReady(
  doc: { id: string; org_id: string; source_document_id?: string | null },
): Promise<void> {
  void import("@/lib/equipmentBridgeServer")
    .then((m) => m.computeForKnowledgeDoc(supabaseAdmin, doc.id))
    .catch(() => undefined);
  await rebuildDocumentMentions(doc);
}

/** Ingest the next PAGE_BATCH pages of one knowledge document. Throws on a
 *  real failure — an IngestBatchError carrying the file, version and resume
 *  point it read; both callers record it with markIngestFailed, which
 *  compares against exactly that. Never throws for contention:
 *  a document someone else is indexing comes back `busy`, a document that
 *  moved under the batch comes back `superseded`. Never throws for a vision
 *  retry that cannot run or failed again either (`visionRetryBlocked`): the
 *  document keeps its index and stays 'indexing' — retrievable — with the
 *  reason on its row. A stored file that is not a PDF comes back `notPdf`
 *  before pdf.js sees it. */
export async function ingestKnowledgeDocBatch(
  doc: KnowledgeDocRow,
  vision?: VisionContext,
  /** Wall-clock stop (epoch ms). EVERY write in this function happens after
   *  the page loop, so an invocation killed by the platform loses the whole
   *  batch and pages_indexed never advances — the client then re-POSTs the
   *  same range forever and indexing stalls at zero. Stopping ourselves,
   *  early and cleanly, is what makes progress durable. */
  deadlineMs?: number,
  opts: {
    /** A person's explicit re-run (the route's `retryNow`): a failed batch's
     *  back-off (ING-8) does not hold it. Every automatic driver leaves it
     *  unset. */
    retryNow?: boolean;
    /** The re-run's record (the route's audit row). Called only when the
     *  re-run is let through and about to be performed — under the claim,
     *  past both gates, with a vision context in hand when the pages waiting
     *  are AI vision's, and before anything is downloaded — so a re-run that
     *  is refused, or only ever meets `busy`, is never recorded. It answers
     *  why it could not record, or null; a record that fails (or throws)
     *  gives the claim back and runs nothing (`retryNowError`). */
    onRetryNow?: (row: Record<string, unknown>, backoffUntil: string) => Promise<string | null>;
  } = {},
): Promise<IngestBatchResult> {
  ensurePdfPolyfills();

  // ── Claim the document for this batch (ING-2) ──────────────────────────
  const driver = `ingest:${randomUUID()}`;
  const lease = await claimIngestLease(doc.id, driver);
  const idle = (row: Record<string, unknown>, flags: Partial<IngestBatchResult>): IngestBatchResult => {
    const failedNow = pageList(row.vision_failed_pages);
    const resumeAt = Number(row.pages_indexed ?? 0);
    return {
      done: row.status === "ready",
      pageCount: Number(row.page_count ?? 0),
      pagesIndexed: resumeAt,
      resumeAt,
      pagesReadable: Math.max(0, resumeAt - failedNow.length),
      emptyPages: 0,
      emptyPagesTotal: Number(row.empty_pages ?? 0),
      visionPages: 0, visionBudgetSpent: false, stoppedForTime: false,
      visionFailedPages: failedNow, visionError: null, visionRetryAttempts: 0,
      busy: false, retryAfterMs: null, superseded: false,
      visionRetryBlocked: false, visionRetryMessage: null, visionRetryAfter: null,
      failureRetryBlocked: false, failureRetryMessage: null, failureRetryAfter: null, retryNowError: null,
      legacy: lease.kind === "unlocked", notPdf: null,
      ...flags,
    };
  };
  if (lease.kind === "busy") {
    // How long the holder's claim can still stand — the whole TTL at most.
    const at = Date.parse(String(lease.row.ingest_claimed_at ?? ""));
    const retryAfterMs = Number.isFinite(at)
      ? Math.min(INGEST_LEASE_TTL_MS, Math.max(0, at + INGEST_LEASE_TTL_MS - Date.now()))
      : INGEST_LEASE_TTL_MS;
    return idle(lease.row, { busy: true, retryAfterMs });
  }
  if (lease.kind === "gone") return idle(doc as unknown as Record<string, unknown>, { done: false, superseded: true });
  const claimed = lease.kind === "claimed" ? lease.row : null;
  const leased = claimed !== null;
  // Work from the row AS CLAIMED — the caller's copy may be a batch old.
  const cur: KnowledgeDocRow = claimed ? { ...doc, ...(claimed as Partial<KnowledgeDocRow>) } : doc;
  let released = false;
  try {
    if (claimed && cur.status === "ready") {
      released = await releaseIngestLease(doc.id, driver);
      return idle(claimed, { done: true });
    }

    const from = Number(cur.pages_indexed ?? 0);           // 0-based next page
    // A batch that starts at page 0 starts a NEW index generation (below).
    const genStart = from === 0;
    const asRow = (claimed ?? (cur as unknown as Record<string, unknown>));

    /** Compare-and-set on what this batch read (ING-1): the row must still
     *  be the file and version this batch read — a rev-up re-points both —
     *  and, under a claim, still ours and still where this batch started. */
    const cas = (q: ReturnType<ReturnType<typeof supabaseAdmin.from>["update"]>) => {
      let out = q.eq("id", cur.id).eq("file_key", cur.file_key);
      if (cur.source_version_id !== undefined) {
        out = cur.source_version_id === null ? out.is("source_version_id", null) : out.eq("source_version_id", cur.source_version_id);
      }
      if (leased) out = out.eq("ingest_claimed_by", driver).eq("pages_indexed", from);
      return out;
    };

    /** Failed vision pages this driver cannot retry now (ING-6): no key, or
     *  the provider refused every retry again. NOT an ingest failure — the
     *  document keeps its whole index and stays 'indexing' (retrievable),
     *  and the row says why (`error`) and when the pages are next tried
     *  (`vision_retry_after`: now when there was no key, which holds no one
     *  back but files the document behind fresh work in the cron's queue;
     *  a back-off after a refused pass). Written with the batch's compare-
     *  and-set, releasing the claim in the same statement. */
    const park = async (
      message: string, retryAfter: string,
      queue?: { failed: number[]; tried: number[]; attempts: number },
    ): Promise<IngestBatchResult> => {
      const stamped = Date.parse(String(cur.vision_retry_after ?? ""));
      const nowMs = Date.now();
      if (claimed && !queue && claimed.error === truncateSafe(message, ERROR_MAX_CHARS) &&
          Number.isFinite(stamped) && stamped <= nowMs && nowMs - stamped < VISION_RETRY_BACKOFF_MS) {
        // A driver without a key that finds its own reason already on the
        // row, stamped within the last half hour and holding no one back,
        // has nothing to add: it gives the claim back and writes nothing
        // else (the app-shell indicator asks again every two minutes, from
        // every open tab). An older stamp is written again, to now: the
        // stamp is the row's place in the cron drain's queue (oldest
        // first), and a parked row that kept its first stamp for good would
        // sort ahead of every lapsed failure — twenty of them would hold
        // the queue's head, in every org, and no failed batch would ever
        // be retried by the nightly run (ING-8).
        released = await releaseIngestLease(doc.id, driver);
      } else if (claimed) {
        const known = new Set(Object.keys(claimed));
        const update = Object.fromEntries(Object.entries({
          error: truncateSafe(message, ERROR_MAX_CHARS), vision_retry_after: retryAfter,
          // A retry pass whose reads ran is not a failed batch (ING-8): it
          // clears the count. A park that read nothing — no key, or no page
          // left to try this round — keeps it, or a failure that persists
          // could be retried (and re-billed) without end.
          ...(queue && queue.attempts > 0 ? { ingest_failures: 0 } : {}),
          // The rotated queue and the round, when a retry pass ran.
          ...(queue ? { vision_failed_pages: queue.failed, vision_retry_tried: queue.tried } : {}),
          ingest_claimed_by: null, ingest_claimed_at: null,
        }).filter(([k]) => known.has(k)));
        const { data, error } = await cas(supabaseAdmin.from("knowledge_documents").update(update)).select("id");
        if (error) throw new Error(error.message);
        if ((data ?? []).length === 0) return idle(asRow, { superseded: true });
        released = true;
      }
      return idle(queue ? { ...asRow, vision_failed_pages: queue.failed } : asRow, {
        visionRetryBlocked: true, visionRetryMessage: message,
        visionRetryAfter: Date.parse(retryAfter) > Date.now() ? retryAfter : null,
        visionRetryAttempts: queue?.attempts ?? 0,
      });
    };

    // ── A failed batch waiting out its back-off (ING-8) ──────────────────
    //    Nothing to do and nothing to write: the failure and when it is next
    //    tried are on the row already. Checked before anything is
    //    downloaded, by every driver alike — except a person's explicit
    //    re-run (`retryNow`), recorded below once it is let through.
    const failureHold = claimed ? failureBackoffUntil(cur) : null;
    if (claimed && failureHold && !opts.retryNow) {
      released = await releaseIngestLease(doc.id, driver);
      return idle(claimed, {
        failureRetryBlocked: true,
        failureRetryMessage: typeof claimed.error === "string" && claimed.error
          ? claimed.error : `The last indexing attempt failed; it is tried again automatically ${NEXT_INDEXING_PASS}.`,
        failureRetryAfter: failureHold,
      });
    }

    // ── The vision retry queue, before anything is downloaded (ING-6) ────
    //    The main pass is through and pages wait on AI vision. A back-off
    //    still running: nothing to do, nothing to write — the reason is
    //    already on the row. No vision context (a keyless controller's tab,
    //    the cron without a sponsored key): nothing can retry them here.
    {
      const waiting = pageList(cur.vision_failed_pages);
      const storedCount = Number(cur.page_count ?? 0);
      if (claimed && !genStart && storedCount > 0 && from >= storedCount && waiting.length > 0 &&
          cur.vision_partial_accepted !== true) {
        const after = Date.parse(String(cur.vision_retry_after ?? ""));
        // One column holds both back-offs. A person's re-run that the gate
        // above let through (`retryNow`, the stamp a failed batch's back-off
        // — failureBackoffUntil) is past it here too: a failed vision-retry
        // batch is retried now, exactly like a failed main-pass one.
        if (Number.isFinite(after) && after > Date.now() && !(opts.retryNow && failureHold)) {
          released = await releaseIngestLease(doc.id, driver);
          return idle(claimed, {
            visionRetryBlocked: true,
            visionRetryMessage: typeof claimed.error === "string" && claimed.error
              ? claimed.error : visionRetryMessage(waiting, "the provider refused the last retry"),
            visionRetryAfter: String(cur.vision_retry_after),
          });
        }
        if (!vision) {
          // A person's re-run with no key that can read the waiting pages (no
          // AI key, or a monthly cap reached) cannot perform the retry: it is
          // refused with the reason, and writes nothing — never a park over
          // the failed batch's record (its cause, its count, its back-off),
          // which every driver still honours. Nothing is recorded either.
          if (opts.retryNow && failureHold) {
            released = await releaseIngestLease(doc.id, driver);
            return idle(claimed, {
              failureRetryBlocked: true,
              failureRetryMessage: visionRetryMessage(waiting, null),
              failureRetryAfter: failureHold,
            });
          }
          return await park(visionRetryMessage(waiting, null), new Date().toISOString());
        }
      }
    }

    // ── A person's re-run, let through (ING-8) ───────────────────────────
    //    Recorded here and only here: under the claim, past both gates,
    //    before anything is downloaded, through the caller's onRetryNow.
    //    A re-run whose record fails runs nothing: any answer but null —
    //    an empty string included — is a refusal. The ingest route always
    //    passes onRetryNow; a caller that omits it (the engine's own tests)
    //    runs the re-run unrecorded.
    if (claimed && failureHold && opts.retryNow && opts.onRetryNow) {
      let refusal: string | null;
      try {
        refusal = await opts.onRetryNow(claimed, failureHold);
      } catch (e) {
        refusal = (e instanceof Error ? e.message : String(e)) || "the record failed";
      }
      if (refusal !== null && refusal !== undefined) {
        refusal = refusal || "the record failed";
        released = await releaseIngestLease(doc.id, driver);
        return idle(claimed, { retryNowError: refusal });
      }
    }

    // ── Is it a PDF at all? (ING-9) — on a generation's first batch,
    //    whichever driver gets there first; the caller refuses it
    //    (refuseNonPdf, comparing against the file read here). The bytes of
    //    another format's container (a spreadsheet or document, an image)
    //    are refused before pdf.js ever sees them. A head with no "%PDF-" in
    //    its first KB is NOT proof: pdf.js opens a PDF behind a long
    //    preamble (a scanner's or a mail gateway's), so such a file is
    //    refused only if pdf.js cannot open it either. An unreadable head
    //    falls through to the download, whose own failure is real.
    let sniffed: SniffedKind | null = null;
    const refuse = async (kind: SniffedKind): Promise<IngestBatchResult> => {
      if (claimed) released = await releaseIngestLease(doc.id, driver);
      return idle(asRow, { notPdf: kind, notPdfRead: readOf(cur) });
    };
    if (genStart) {
      try { sniffed = await sniffStoredFile(cur.file_key); } catch { sniffed = null; }
      if (sniffed === "office" || sniffed === "image") return await refuse(sniffed);
    }

    // Pull the PDF from R2 (each batch re-downloads; simple and stateless).
    const obj = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: cur.file_key }));
    const bytes = new Uint8Array(await new Response(obj.Body as ReadableStream).arrayBuffer());

    const { getDocumentProxy, renderPageAsImage } = await import("unpdf");
    let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
    try {
      pdf = await getDocumentProxy(bytes);
    } catch (e) {
      // No header where one belongs, and pdf.js cannot open it either: not
      // a PDF. A file that carried the header is a damaged PDF — a real
      // failure, reported as one, and one no retry can mend (ING-8).
      if (sniffed === "text" || sniffed === "unknown") return await refuse(sniffed);
      throw new IngestBatchError(e instanceof Error ? e.message : String(e), readOf(cur), true);
    }
    const pageCount = pdf.numPages;

    const to = Math.min(from + PAGE_BATCH, pageCount);
    let emptyPages = 0;
    let visionPages = 0;
    let visionBudgetSpent = false;
    let stoppedForTime = false;
    let lastCompletedPage = from;                          // for early stops
    const rows: Array<Record<string, unknown>> = [];
    // Section heading in force where the last batch left off — sections span
    // pages, so it persists on the document row between batches.
    let section: string | null = cur.last_section ?? null;
    let visionLeft = vision?.budgetPages ?? 0;
    let visionError: string | null = null;

    // ING-6: pages whose vision read failed on a provider error. They are
    // committed with whatever their text layer holds, remembered on the row,
    // and retried once the main pass is through; the document is 'ready'
    // only when none remain (or someone explicitly accepted the partial
    // index).
    //
    // A batch that starts at page 0 starts a NEW index generation, however
    // the row got there — the rev-up refresh, the drawing rebuild, a fresh
    // upload: every counter restarts from zero here, so no reset path can
    // carry the last generation's vision_pages / empty_pages / failed pages
    // into this one (ING-12, ING-11), even one that forgot to zero them.
    //
    // The row's list is a QUEUE, least recently tried first: a page whose
    // retry fails again goes to the back, so pages that fail every time can
    // never keep the ones behind them from being tried. `vision_retry_tried`
    // holds the pages whose retry failed since the last back-off (the round):
    // the retry pass backs off only once every waiting page has had its try.
    const queueBefore = genStart ? [] : pageQueue(cur.vision_failed_pages);
    const failed = new Set<number>(queueBefore);
    const tried = new Set<number>(genStart ? [] : pageQueue(cur.vision_retry_tried).filter((p) => failed.has(p)));
    const accepted = !genStart && cur.vision_partial_accepted === true;
    const retryMode = from >= pageCount && queueBefore.length > 0 && !accepted;
    const baseVisionPages = genStart ? 0 : Number(cur.vision_pages ?? 0);
    const baseEmptyPages = genStart ? 0 : Number(cur.empty_pages ?? 0);

    // Which chunker (ING-4 / ING-7): a document keeps the one it started
    // with — its chunk boundaries never mix — and a document (re)starting at
    // its first page takes its library's current choice. Unclaimed (a
    // database without 20261122) there is nowhere to record it: chunker 1.
    // A library read that FAILS is not a choice: only a database without the
    // column falls back to chunker 1 — any other error stops the batch (it is
    // retried, ING-8), rather than stamping chunker 1 on a chunker-2
    // library's document, which the next re-index would reset and re-bill.
    let chunkVersion: ChunkerVersion = chunkerVersionOf(cur.chunk_version);
    if (claimed && !retryMode && from === 0) {
      const { data: lib, error: libErr } = await supabaseAdmin
        .from("knowledge_libraries").select("chunk_version").eq("id", cur.library_id).maybeSingle();
      if (libErr && !isMissingColumn(libErr)) throw new Error(`library chunker could not be read: ${libErr.message}`);
      chunkVersion = libErr ? CHUNKER_LEGACY : chunkerVersionOf((lib as { chunk_version?: unknown } | null)?.chunk_version);
    }
    const tableAware = chunkVersion === CHUNKER_TABLE_AWARE;
    /** Chunker 2 carries the unfinished sentence at the foot of a page into
     *  the next (ING-7). Across a batch boundary it is read back from the
     *  last chunk stored for the previous page — prose chunks are single
     *  lines, so a chunk with a line break is a table and carries nothing,
     *  and a page that declared a title block (a drawing sheet) carries
     *  nothing either. */
    const storedTail = async (page: number): Promise<{ text: string; fromPage: number } | null> => {
      if (!tableAware || page < 1) return null;
      const { data } = await supabaseAdmin.from("knowledge_chunks")
        .select("content").eq("document_id", cur.id).eq("page", page)
        .order("seq", { ascending: false }).limit(1);
      const last = ((data ?? []) as Array<{ content: string }>)[0]?.content ?? "";
      const text = last.includes("\n") ? "" : pageTail(last);
      if (!text) return null;
      const { data: sheet, error: sheetErr } = await supabaseAdmin.from("knowledge_page_entities")
        .select("id").eq("document_id", cur.id).eq("page", page).eq("kind", "self").limit(1);
      if (!sheetErr && (sheet ?? []).length > 0) return null;
      return { text, fromPage: page };
    };

    const entityRows: Array<Record<string, unknown>> = [];
    type TextItem = { str?: string; hasEOL?: boolean; transform?: number[] };
    type PageRead = {
      lines: string[];
      /** What the chunker reads: `lines`, except that chunker 2 rebuilds a
       *  text-layer page with its column gaps measured (ING-4). */
      chunkLines: string[];
      visionRead: boolean;
      visionModel: string | null;
      /** The provider's message when the vision read failed (not a timeout). */
      visionFailed: string | null;
      entities: Array<Record<string, unknown>>;
    };

    /** Read one page: text layer, the vision fallback when the page can't be
     *  read from it, and the drawing entities. `stop` when the page must not
     *  be started (out of clock / vision budget) — the batch ends before it. */
    const readPage = async (p: number, forceVision: boolean): Promise<{ stop: "time" | "budget" } | { stop: null; page: PageRead }> => {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      // Rebuild LINES (not one long string): heading detection needs them.
      // Broken font CMaps put LONE SURROGATES / control bytes in the text
      // layer; unsanitized they reach the chunk insert and Postgres refuses
      // the whole batch ("invalid input syntax for type json"). Scrub at the
      // source so every consumer (chunks, tags, captions) gets clean text.
      let lines: string[] = pageLinesFromTextItems(content.items as PdfTextItem[]).map(sanitizeStorageText);
      let chunkLines: string[] = tableAware
        ? pageLinesFromTextItems(content.items as PdfTextItem[], { columnGaps: true }).map(sanitizeStorageText)
        : lines;

      // ── VISION FALLBACK: this page can't be read from its text layer.
      //    AutoCAD SHX text plots as LINE-WORK (tags exist as strokes, not
      //    text objects) and scans have no text at all. A drawing can even
      //    look "readable" — a TrueType title block yields a few hundred
      //    characters while every tag stays invisible — so the decision uses
      //    tags-found, not just length (see pageNeedsVision). The transcript
      //    then flows through the SAME pipeline (sections → chunks → tags →
      //    refs), making the sheet fully searchable and citable.
      let visionRead = false;
      let visionModel: string | null = null;
      let visionFailed: string | null = null;
      const rawPageText = lines.join("\n");
      const tagsFromText = extractEquipmentTags(rawPageText).length + extractDrawingRefs(rawPageText).length;
      if (forceVision || vision?.forceAllPages || pageNeedsVision(rawPageText, tagsFromText)) {
        // Don't START a vision page we can't finish — a page begun at t=50s on
        // a 60s function is pure waste, and worse, it takes the whole batch's
        // committed progress down with it.
        const timeForVision = !deadlineMs || Date.now() + VISION_PAGE_RESERVE_MS <= deadlineMs;
        if (vision && visionLeft > 0 && timeForVision) {
          try {
            const img = await renderPageAsImage(pdf, p, {
              width: 1800,                                  // small tags stay legible
              canvasImport: () => import("@napi-rs/canvas"),
            });
            const out = await transcribePageImage({
              provider: vision.provider,
              fallbackModel: vision.model,
              apiKey: vision.apiKey,
              base64: Buffer.from(img as ArrayBuffer).toString("base64"),
              mediaType: "image/png",
              documentName: cur.name,
              page: p,
              instructions: vision.instructions,
              // Whatever's left after rendering, minus room to commit.
              timeoutMs: deadlineMs ? Math.max(5_000, deadlineMs - Date.now() - 4_000) : undefined,
            });
            vision.onUsage(out.usage, out.model);
            visionLeft--;
            const transcript = out.text.trim();
            // A transcript this short means the model found nothing legible:
            // the page was READ, and it is empty (counted in empty_pages).
            if (transcript.length >= TEXTLESS_PAGE_MAX_CHARS) {
              lines = transcript.split("\n")
                .map((l) => sanitizeStorageText(l.trim())).filter(Boolean);
              chunkLines = lines;
              visionRead = true;
              visionModel = out.model;
              visionPages++;
            }
          } catch (e) {
            if (isTimeoutError(e)) {
              // Ran out of clock, not out of luck. Stop BEFORE finishing this
              // page so a fresh invocation retries it with a full budget —
              // otherwise a slow page would silently downgrade to text-only.
              return { stop: "time" };
            }
            // Provider hiccup: the page keeps its text layer for now and is
            // RECORDED as failed (ING-6) — retried once the main pass is
            // through, and the document is not 'ready' while it is pending.
            visionLeft--;
            visionFailed = sanitizeStorageText((e as Error)?.message || "provider error").slice(0, 300);
          }
        } else if (vision) {
          // Out of page budget, or out of clock — either way stop cleanly at
          // the last finished page so the caller's next call resumes exactly
          // here with a fresh invocation's worth of time.
          return { stop: timeForVision ? "budget" : "time" };
        }
      }

      // ── Drawing intelligence: on sparse (drawing-like) pages, extract
      //    equipment tags and drawing-number references WITH the position of
      //    the text item that carried them — the structured layer behind the
      //    equipment census, register export, and reference audit.
      //    Vision-read pages have no positions (the transcript is text), so
      //    they extract from the lines themselves.
      const entities: Array<Record<string, unknown>> = [];
      const pageText = lines.join("\n");
      if (visionRead) {
        for (const line of lines) {
          for (const hit of extractEquipmentTags(line)) {
            entities.push({
              org_id: cur.org_id, library_id: cur.library_id, document_id: cur.id,
              page: p, kind: "equipment", tag: hit.tag, raw: truncateSafe(line, 160), x: null, y: null,
              nx: null, ny: null, pos_source: null,
            });
          }
          for (const ref of extractDrawingRefs(line)) {
            entities.push({
              org_id: cur.org_id, library_id: cur.library_id, document_id: cur.id,
              page: p, kind: "ref", tag: ref, raw: truncateSafe(line, 160), x: null, y: null,
              nx: null, ny: null, pos_source: null,
            });
          }
        }
      } else if (isDrawingLikePage(pageText)) {
        // Normalized position rides along with every hit: PDF user space has
        // its origin at the BOTTOM-left and is sized in points, neither of
        // which a browser overlay can use. 0..1 from the top-left survives any
        // zoom or render width, so "show me V-3" can point straight at it.
        const view = page.getViewport({ scale: 1 });
        const norm = (x: number | null, y: number | null) =>
          x === null || y === null || !view.width || !view.height
            ? { nx: null, ny: null }
            : { nx: clamp01(x / view.width), ny: clamp01(1 - y / view.height) };
        for (const item of content.items as TextItem[]) {
          const str = (item.str ?? "").trim();
          if (str.length < 2) continue;
          const x = item.transform?.[4] ?? null;
          const y = item.transform?.[5] ?? null;
          const { nx, ny } = norm(x, y);
          for (const hit of extractEquipmentTags(str)) {
            entities.push({
              org_id: cur.org_id, library_id: cur.library_id, document_id: cur.id,
              page: p, kind: "equipment", tag: hit.tag, raw: truncateSafe(str, 160), x, y,
              nx, ny, pos_source: nx === null ? null : "text",
            });
          }
          for (const ref of extractDrawingRefs(str)) {
            entities.push({
              org_id: cur.org_id, library_id: cur.library_id, document_id: cur.id,
              page: p, kind: "ref", tag: ref, raw: truncateSafe(str, 160), x, y,
              nx, ny, pos_source: nx === null ? null : "text",
            });
          }
        }
      }

      // ── Sheet identity from the TITLE BLOCK ────────────────────────────
      // The border says who this sheet is — drawing number, sheet, rev. That
      // declaration (kind 'self') is what the reference audit trusts;
      // filenames are only a fallback for sheets that never declared.
      if (visionRead || isDrawingLikePage(pageText)) {
        // Off-page connector BOX NUMBERS — the small numbered box at the page
        // edge that pairs with the same number on the continuation sheet. The
        // raw line keeps the stream/destination + drawing ref for pairing.
        for (const line of lines) {
          for (const box of parseOpcBoxes(line)) {
            entities.push({
              org_id: cur.org_id, library_id: cur.library_id, document_id: cur.id,
              page: p, kind: "opc", tag: box, raw: truncateSafe(line, 160), x: null, y: null,
              nx: null, ny: null, pos_source: null,
            });
          }
        }
        const tb = extractTitleBlock(pageText);
        if (tb.drawingNumber) {
          const raw = truncateSafe(`DWG ${tb.drawingNumber}` +
            (tb.sheetNumber ? ` SH ${tb.sheetNumber}` : "") +
            (tb.rev ? ` REV ${tb.rev}` : ""), 160);
          const self = (tag: string) => entities.push({
            org_id: cur.org_id, library_id: cur.library_id, document_id: cur.id,
            page: p, kind: "self", tag, raw, x: null, y: null,
            nx: null, ny: null, pos_source: null,
          });
          self(tb.drawingNumber);
          if (tb.sheetNumber) self(`${tb.drawingNumber}-SH${tb.sheetNumber}`);
        }
      }

      // ── Caption anchors: TABLE 3 / FIGURE 5-1 become addressable ──────
      // Standards constantly say "see Table 3" — and until now "Table 3" was
      // just two words in some chunk. Recording where each caption LIVES lets
      // the ask route pull the actual table (text and page image) whenever
      // prose points at it, instead of hoping retrieval stumbles onto it.
      for (const line of lines) {
        const cap = CAPTION_RE.exec(line);
        if (!cap) continue;
        const kindWord = cap[1].toUpperCase().startsWith("FIG") ? "FIGURE"
          : cap[1].toUpperCase() === "CHART" ? "CHART"
          : cap[1].toUpperCase() === "DETAIL" ? "DETAIL" : "TABLE";
        entities.push({
          org_id: cur.org_id, library_id: cur.library_id, document_id: cur.id,
          page: p, kind: "anchor", tag: `${kindWord} ${cap[2].toUpperCase()}`,
          raw: truncateSafe(line.trim(), 160), x: null, y: null,
          nx: null, ny: null, pos_source: null,
        });
      }

      return { stop: null, page: { lines, chunkLines, visionRead, visionModel, visionFailed, entities } };
    };

    /** A drawing sheet has no sentence to finish — its foot is a title
     *  block or a tag list — so the carry (ING-7, prose only) neither leaves
     *  nor enters one: a page that declared a title block (a 'self' entity,
     *  text layer or vision transcript alike), or a sparse page dense with
     *  tags. */
    const sheetLike = (read: PageRead): boolean => {
      if (read.entities.some((e) => e.kind === "self")) return true;
      if (!isDrawingLikePage(read.lines.join("\n"))) return false;
      return read.entities.filter((e) => e.kind === "equipment" || e.kind === "ref").length >= MIN_TAGS_THIN_PAGE;
    };

    /** Chunk one read page. Every row says how its text was obtained —
     *  'text' (the PDF's own text layer) or 'vision' (an AI transcription,
     *  with the model that wrote it) — GOV-9. Chunker 2 keeps line
     *  structure (tables stay whole — ING-4) and opens a prose page with the
     *  previous prose page's unfinished sentence, marked with where it came
     *  from (ING-7); it also returns this page's own unfinished sentence. */
    const chunkRowsFor = (p: number, read: PageRead, carry: string | null, carried: { text: string; fromPage: number } | null) => {
      const { segments, lastSection } = tableAware
        ? splitPageIntoSections(read.chunkLines, carry, { keepLines: true })
        : splitPageIntoSections(read.lines, carry);
      let tail = "";
      if (tableAware && segments.length > 0 && !sheetLike(read)) {
        // This page's OWN unfinished sentence, taken before anything is
        // prepended — a carry is never carried on.
        const parts = splitTables(segments[segments.length - 1].text);
        const last = parts[parts.length - 1];
        if (last?.kind === "prose") tail = pageTail(last.text);
        // Only a page that continues the same section continues a sentence.
        if (carried && segments[0].section === carry && !hasCarriedMarker(carried.text)) {
          segments[0] = { ...segments[0], text: `${carriedTailMarker(carried.fromPage)} ${carried.text}\n${segments[0].text}` };
        }
      }
      const out: Array<Record<string, unknown>> = [];
      let seq = 0;
      for (const seg of segments) {
        for (const c of chunkPageText(seg.text)) {
          out.push({
            org_id: cur.org_id, library_id: cur.library_id, document_id: cur.id,
            page: p, seq: seq++, content: c, section: seg.section,
            source: read.visionRead ? "vision" : "text",
            source_model: read.visionRead ? read.visionModel : null,
          });
        }
      }
      return { rows: out, lastSection, hadText: out.length > 0, tail: tail ? { text: tail, fromPage: p } : null };
    };

    // Pages rewritten by the retry pass, and whether each now holds text.
    const retried = new Map<number, boolean>();
    // Pages the retry pass tried and could not read again, in the order
    // tried — they go to the back of the queue.
    const failedAgain: number[] = [];
    let attempted = 0;
    // The retry pass's round ran out: every waiting page failed again since
    // the last back-off — the next one starts at this commit (ING-6).
    let roundBackoff: { message: string; after: string } | null = null;
    if (!retryMode) {
      let carried = await storedTail(from);
      for (let p = from + 1; p <= to; p++) {                 // pdf.js pages are 1-based
        if (deadlineMs && Date.now() >= deadlineMs) { stoppedForTime = true; break; }
        const step = await readPage(p, false);
        if (step.stop) {
          if (step.stop === "time") stoppedForTime = true; else visionBudgetSpent = true;
          break;
        }
        const read = step.page;
        entityRows.push(...read.entities);
        if (read.visionFailed) { failed.add(p); visionError = read.visionFailed; }
        else failed.delete(p);
        lastCompletedPage = p;
        const built = chunkRowsFor(p, read, section, carried);
        carried = built.tail;
        section = built.lastSection;
        rows.push(...built.rows);
        if (!built.hadText) emptyPages++;
      }
    } else {
      // ── RETRY PASS (ING-6): the main pass is through; re-read only the
      //    pages whose vision call failed. No key = nothing can retry them
      //    here: said on the row, never an error (normally caught above,
      //    before the download).
      if (!vision) return await park(visionRetryMessage(pageList(queueBefore), null), new Date().toISOString());
      const backoff = () => new Date(Date.now() + VISION_RETRY_BACKOFF_MS).toISOString();
      // Least recently tried first; a page that already failed this round
      // waits for the next one.
      const candidates = queueBefore.filter((p) => !tried.has(p));
      if (candidates.length === 0) {
        // Every waiting page failed again this round (normally the batch that
        // finished the round backed off already): back off now.
        return await park(visionRetryMessage(pageList(queueBefore), "the provider refused the last retry"),
          backoff(), { failed: queueBefore, tried: [], attempts: 0 });
      }
      for (const p of candidates) {
        if (deadlineMs && Date.now() >= deadlineMs) { stoppedForTime = true; break; }
        const step = await readPage(p, true);
        if (step.stop) {
          if (step.stop === "time") stoppedForTime = true; else visionBudgetSpent = true;
          break;
        }
        attempted++;
        const read = step.page;
        if (read.visionFailed) { visionError = read.visionFailed; failedAgain.push(p); tried.add(p); continue; }
        failed.delete(p);
        tried.delete(p);
        entityRows.push(...read.entities);
        // The section in force where this page begins: the last one written
        // on an earlier page.
        const { data: prev } = await supabaseAdmin.from("knowledge_chunks")
          .select("section").eq("document_id", cur.id).lt("page", p)
          .order("page", { ascending: false }).order("seq", { ascending: false }).limit(1);
        const carry = ((prev ?? []) as Array<{ section: string | null }>)[0]?.section ?? null;
        const built = chunkRowsFor(p, read, carry, await storedTail(p - 1));
        rows.push(...built.rows);
        retried.set(p, built.hadText);
      }
      // The queue after this pass: pages not tried keep their place at the
      // front, pages that failed again go to the back.
      const again = new Set(failedAgain);
      const queueAfter = [...queueBefore.filter((p) => failed.has(p) && !again.has(p)), ...failedAgain];
      const roundDone = queueAfter.length > 0 && queueAfter.every((p) => tried.has(p));
      if (roundDone && retried.size === 0) {
        // Every waiting page failed again since the last back-off: back off
        // and say so on the row — the document keeps its index and stays
        // retrievable; the pages are tried again after the back-off, or a
        // person accepts the partial index.
        return await park(visionRetryMessage(pageList(queueAfter), visionError), backoff(),
          { failed: queueAfter, tried: [], attempts: attempted });
      }
      if (roundDone) {
        // Pages were read, and the rest have all had their try: the commit
        // below records the reads AND starts the back-off.
        // (This batch's own tries may all have read: the cause is then the
        // earlier refusal, which the row no longer spells out.)
        roundBackoff = {
          message: visionRetryMessage(pageList(queueAfter), visionError ?? "the provider refused the last retry"),
          after: backoff(),
        };
        tried.clear();
      }
      // Otherwise pages behind the ones that failed again are still waiting
      // for their try this round: the commit records the rotated queue and
      // the next batch — no back-off — tries them.
      failed.clear();
      for (const p of queueAfter) failed.add(p);
    }

    // Everything below advances only as far as the last FULLY processed page
    // (a vision-budget stop can end the batch early).
    const reached = retryMode ? from : lastCompletedPage;
    const rewrite = retryMode ? [...retried.keys()] : [];
    const touched = retryMode ? rewrite.length > 0 : reached > from;
    const fullClear = genStart && leased;

    // Rows this batch wrote — withdrawn if it turns out to be superseded.
    const insertedChunkIds: string[] = [];
    const insertedEntityIds: string[] = [];
    /** Delete exactly the rows this batch inserted. Each delete is checked
     *  and tried once more; what still fails is returned, never dropped. */
    const withdraw = async (): Promise<string[]> => {
      const left: string[] = [];
      for (const [table, ids] of [["knowledge_chunks", insertedChunkIds], ["knowledge_page_entities", insertedEntityIds]] as const) {
        for (let i = 0; i < ids.length; i += 200) {
          const slice = ids.slice(i, i + 200);
          let { error } = await supabaseAdmin.from(table).delete().in("id", slice);
          if (error) ({ error } = await supabaseAdmin.from(table).delete().in("id", slice));
          if (error) left.push(`${slice.length} ${table} rows: ${error.message}`);
        }
      }
      return left;
    };
    /** Withdraw, and say so when it could not be done. Under the claim the
     *  rows a failed withdrawal leaves are cleared before anything else is
     *  written over them: a re-pointed row's next batch starts a new index
     *  generation, whose first batch clears the whole derived index, and a
     *  row that did not move re-clears this batch's range before it writes.
     *  Unclaimed (a database without 20261122) no batch does a full clear,
     *  so a row that moved to another file is re-queued through the shared
     *  reset — every derived row goes, and the new file is read from its
     *  first page — as long as the row still says what the check read (the
     *  reset's `expect`). Returns the failure, or null. */
    const withdrawOrRequeue = async (): Promise<string | null> => {
      const left = await withdraw();
      if (left.length === 0) return null;
      let note = left.join("; ");
      if (!leased) {
        const { data: now } = await supabaseAdmin.from("knowledge_documents").select("*").eq("id", cur.id).maybeSingle();
        const row = now as Record<string, unknown> | null;
        const moved = !!row && (row.file_key !== cur.file_key ||
          (cur.source_version_id !== undefined && "source_version_id" in row && (row.source_version_id ?? null) !== (cur.source_version_id ?? null)));
        if (moved) {
          // Only while the row still says what this check read: an unclaimed
          // batch of the new file that committed since keeps its pages. (One
          // still writing cannot be seen without the claim — its commit
          // compares the file and version only — so a reset can still land
          // under it: the legacy residual, ING-1.)
          const seenNow = row!;
          const res = await resetKnowledgeIndex([cur.id], {
            expect: () => ({
              file_key: seenNow.file_key, pages_indexed: seenNow.pages_indexed,
              ...("source_version_id" in seenNow ? { source_version_id: seenNow.source_version_id } : {}),
            }),
          });
          note += res.reset.length > 0 ? " — the document was re-queued for a full re-index"
            : ` — it could not be re-queued (${res.errors.join("; ") || "another driver moved it first"})`;
        }
      }
      return `rows this batch wrote could not be withdrawn: ${note}`;
    };
    const collide = (e: DbError) =>
      !!e && (e.code === "23505" || e.code === "23503" || /duplicate key|violates foreign key/i.test(e.message ?? ""));

    let emptyDelta = emptyPages;
    try {
      if (touched) {
        // Idempotent batch: the processed page range is cleared before it is
        // rewritten — ALWAYS, not only when this pass produced rows, so a
        // range that now yields nothing no longer keeps the last run's text
        // (belt) — and the unique (document, page, seq) index is the
        // suspenders. A failed clear stops the batch: rewriting over rows
        // that are still there is how duplicates were born. The FIRST batch
        // of a new index generation, under the claim, clears the document's
        // whole derived index instead: nothing of the last generation (an
        // interrupted reset's leftovers included) outlives it.
        let del = supabaseAdmin.from("knowledge_chunks").delete().eq("document_id", cur.id);
        del = retryMode ? del.in("page", rewrite) : fullClear ? del : del.gte("page", from + 1).lte("page", reached);
        const { data: cleared, error: delErr } = await del.select("page");
        if (delErr) throw new Error(`chunk cleanup failed: ${delErr.message}`);
        if (retryMode) {
          // empty_pages follows the page: a retried page that was empty and
          // now holds text leaves the count, and the reverse joins it.
          const hadBefore = new Set(((cleared ?? []) as Array<{ page: number }>).map((r) => Number(r.page)));
          emptyDelta = 0;
          for (const [p, hasText] of retried) emptyDelta += (hasText ? 0 : 1) - (hadBefore.has(p) ? 0 : 1);
        }
      }
      if (rows.length > 0) {
        // BOUNDED sub-batches, not one statement. Every inserted row computes
        // two weighted tsvectors (20261007) and updates a GIN index, and three
        // ingest workers now run concurrently — a single 50-page INSERT blew
        // Postgres's statement_timeout in production ('canceling statement due
        // to statement timeout'), taking the serverless invocation down with it
        // as a 502. Small statements keep each one comfortably inside the
        // timeout; a timeout that still slips through halves the batch and
        // retries rather than failing the page range.
        const insertChunks = async (rawBatch: typeof rows): Promise<void> => {
          // LAST LINE OF DEFENSE, on EVERY insert — not a retry. Extraction
          // sanitizes lines, but the CHUNKER slices at arbitrary indices and a
          // cut through a surrogate pair re-creates the exact poison sanitize
          // removed (proven by reproduction: astral-dense pages poisoned 3 of 5
          // chunks AFTER clean sanitization). Chunking is pair-safe now too,
          // but nothing unstorable reaches the wire regardless of what any
          // future upstream code produces. Cost: microseconds per chunk.
          let batch: Array<Record<string, unknown>> = rawBatch.map((r) => ({
            ...r,
            content: sanitizeStorageText(String(r.content ?? "")),
            section: r.section == null ? r.section : sanitizeStorageText(String(r.section)),
          }));
          const put = async (b: Array<Record<string, unknown>>) => {
            const { data, error } = await supabaseAdmin.from("knowledge_chunks").insert(b).select("id");
            if (!error) for (const r of (data ?? []) as Array<{ id: string }>) insertedChunkIds.push(r.id);
            return error;
          };
          let insErr = await put(batch);
          if (insErr && isMissingColumn(insErr) && /source/.test(insErr.message ?? "")) {
            // Pre-20261122 DB: the provenance columns (GOV-9) wait for it.
            batch = batch.map(({ source: _s, source_model: _m, ...rest }) => rest);
            insErr = await put(batch);
          }
          if (insErr && (insErr.code === "PGRST204" || /section/.test(insErr.message ?? ""))) {
            // Pre-20260914 DB: retry without the section column.
            batch = batch.map(({ section: _s, source: _o, source_model: _m, ...rest }) => rest);
            insErr = await put(batch);
          }
          // Another writer already holds this range (a duplicate key), or the
          // document was deleted underneath us: not an indexing failure.
          if (collide(insErr)) throw new IngestSuperseded(insErr!.message);
          if (insErr && /statement timeout/i.test(insErr.message ?? "") && batch.length > 1) {
            const mid = Math.ceil(batch.length / 2);
            await insertChunks(batch.slice(0, mid));
            await insertChunks(batch.slice(mid));
            return;
          }
          // Residual encoding rejects — Postgres's wording ("invalid input
          // syntax for type json", "unsupported Unicode escape", "invalid byte
          // sequence") AND PostgREST's own parse failure ("Empty or invalid
          // json", PGRST102): retry once per-row so one bad row can't take 29
          // good ones down with it.
          if (insErr && /invalid input syntax for type json|unsupported unicode|invalid byte sequence|empty or invalid json/i.test(insErr.message ?? "")) {
            insErr = null;
            for (const row of batch) {
              const rowErr = await put([row]);
              if (collide(rowErr)) throw new IngestSuperseded(rowErr!.message);
              if (rowErr) insErr = rowErr;
            }
          }
          if (insErr) throw new Error(`chunk insert failed: ${insErr.message}`);
        };
        for (let i = 0; i < rows.length; i += 30) {
          await insertChunks(rows.slice(i, i + 30));
        }
      }

      // Drawing entities: same idempotent shape as chunks (clear the page
      // range, rewrite) — and the clear now runs whether or not this pass
      // found anything (DWG-1): a re-read that extracts nothing must not
      // leave the last revision's tags standing on those pages. A missing
      // table (pre-20260921) skips the tag layer; any other failure stops the
      // batch before pages_indexed moves (ING-8).
      let entitiesLive = true;
      if (touched) {
        let del = supabaseAdmin.from("knowledge_page_entities").delete().eq("document_id", cur.id);
        del = retryMode ? del.in("page", rewrite) : fullClear ? del : del.gte("page", from + 1).lte("page", reached);
        const { error: delErr } = await del;
        if (delErr) {
          if (isMissingTable(delErr)) entitiesLive = false;
          else throw new Error(`entity cleanup failed: ${delErr.message}`);
        }
      }
      if (entitiesLive && entityRows.length > 0) {
        // Layered fallbacks: one schema mismatch must never cost the whole tag
        // layer. (It did once — the original CHECK (kind IN ('equipment','ref'))
        // rejected 'self'/'opc' rows, each bad row failed its batch of 500, and
        // a rebuild wiped the index and wrote NOTHING back.)
        const CORE_KINDS = new Set(["equipment", "ref"]);
        const insertEntities = async (slice: Array<Record<string, unknown>>): Promise<void> => {
          let batch = slice;
          const put = async (b: Array<Record<string, unknown>>) => {
            const { data, error } = await supabaseAdmin.from("knowledge_page_entities").insert(b).select("id");
            if (!error) for (const r of (data ?? []) as Array<{ id: string }>) insertedEntityIds.push(r.id);
            return error;
          };
          let error = await put(batch);
          if (error && /nx|ny|pos_source|column/i.test(error.message ?? "") && !isMissingTable(error)) {
            // Position columns arrive with migration 20260924 — a DB that
            // hasn't run it yet must still get its TAGS.
            batch = batch.map(({ nx: _nx, ny: _ny, pos_source: _ps, ...rest }) => rest);
            error = await put(batch);
          }
          if (error && /check|kind/i.test(error.message ?? "")) {
            // Pre-20260925 CHECK constraint: only equipment/ref pass. Keep the
            // core layer; self/opc simply wait for the migration.
            batch = batch.filter((r) => CORE_KINDS.has(String(r.kind)));
            error = batch.length > 0 ? await put(batch) : null;
          }
          if (error && isMissingTable(error)) { entitiesLive = false; return; }
          if (collide(error)) throw new IngestSuperseded(error!.message);
          // A timeout halves and retries, exactly like the chunk path — it no
          // longer drops every remaining slice after an already-run delete.
          if (error && /statement timeout/i.test(error.message ?? "") && batch.length > 1) {
            const mid = Math.ceil(batch.length / 2);
            await insertEntities(batch.slice(0, mid));
            if (entitiesLive) await insertEntities(batch.slice(mid));
            return;
          }
          // Anything else is a real failure: the batch is retried, never
          // committed as complete with a blank tag layer (ING-8).
          if (error) throw new Error(`entity insert failed: ${error.message}`);
        };
        for (let i = 0; i < entityRows.length && entitiesLive; i += 500) {
          await insertEntities(entityRows.slice(i, i + 500));
        }
      }

      // A document whose new revision has FEWER pages keeps nothing past its
      // last page (ING-3): not text, not tags.
      if (!retryMode && touched) {
        const { error: pruneErr } = await supabaseAdmin.from("knowledge_chunks")
          .delete().eq("document_id", cur.id).gt("page", pageCount);
        if (pruneErr) throw new Error(`chunk prune failed: ${pruneErr.message}`);
        if (entitiesLive) {
          const { error: entPruneErr } = await supabaseAdmin.from("knowledge_page_entities")
            .delete().eq("document_id", cur.id).gt("page", pageCount);
          if (entPruneErr && !isMissingTable(entPruneErr)) throw new Error(`entity prune failed: ${entPruneErr.message}`);
        }
      }
    } catch (e) {
      if (e instanceof IngestSuperseded) {
        const left = await withdrawOrRequeue();
        if (left) throw new Error(`superseded (${e.message}), and ${left}`);
        return idle(cur as unknown as Record<string, unknown>, { superseded: true });
      }
      // A real failure writes nothing either: what this batch inserted goes
      // with it (the next attempt rewrites the range anyway), so a batch a
      // rev-up superseded mid-flight leaves none of the old file's rows
      // under the re-pointed revision.
      const left = await withdrawOrRequeue().catch((w: unknown) => `withdrawal failed: ${(w as Error).message}`);
      if (left) throw new Error(`${(e as Error).message}; and ${left}`);
      throw e;
    }

    // ── Commit: compare-and-set on what this batch read (ING-1) ──────────
    // The row stores the retry queue (least recently tried first); a person
    // reads the pages in page order.
    const failedQueue = [...failed];
    const failedAfter = [...failedQueue].sort((a, b) => a - b);
    const done = reached >= pageCount && (failedAfter.length === 0 || accepted);
    // Only a batch that did work — read a page, tried a vision retry, or
    // finished the document — says anything about a failed batch before it
    // (ING-8): its commit clears the count, the failure's message and its
    // back-off. One that stopped for time or budget before its first page
    // did nothing, and leaves all three exactly as they are: a no-op must
    // never reset the bound on re-billing, nor erase the failure's record.
    const didWork = touched || done || attempted > 0;
    const emptyTotal = Math.max(0, baseEmptyPages + emptyDelta);
    const docUpdate: Record<string, unknown> = {
      page_count: pageCount,
      pages_indexed: reached,
      status: done ? "ready" : "indexing",
      error: null,
      last_section: retryMode ? (cur.last_section ?? null) : section,
    };
    let committed = 0;
    let updErr: DbError = null;
    if (claimed) {
      const known = new Set(Object.keys(claimed));
      const full: Record<string, unknown> = {
        ...docUpdate,
        vision_pages: baseVisionPages + visionPages,
        empty_pages: emptyTotal,
        vision_failed_pages: failedQueue,
        vision_retry_tried: failedQueue.filter((p) => tried.has(p)),
        // A controller's acceptance is written only by accept-partial (under
        // its own claim) and cleared only by a new generation — a batch never
        // writes back a copy it read.
        ...(genStart ? { vision_partial_accepted: false } : {}),
        // A batch that did work is not a failed one (ING-8), and holds no
        // one back — unless it finished a vision-retry round (ING-6).
        ...(didWork ? { ingest_failures: 0, vision_retry_after: roundBackoff?.after ?? null } : {}),
        ...(roundBackoff ? { error: truncateSafe(roundBackoff.message, ERROR_MAX_CHARS) } : {}),
        chunk_version: chunkVersion,
        ingest_claimed_by: null, ingest_claimed_at: null,
      };
      // …and one that did nothing leaves the row's message as it is.
      if (!didWork) delete full.error;
      const update = Object.fromEntries(Object.entries(full).filter(([k]) => known.has(k)));
      const { data, error } = await cas(supabaseAdmin.from("knowledge_documents").update(update)).select("id");
      updErr = error; committed = (data ?? []).length;
    } else {
      let { data, error } = await cas(supabaseAdmin.from("knowledge_documents").update(docUpdate)).select("id");
      if (error && (error.code === "PGRST204" || /last_section/.test(error.message ?? ""))) {
        delete docUpdate.last_section;
        ({ data, error } = await cas(supabaseAdmin.from("knowledge_documents").update(docUpdate)).select("id"));
      }
      updErr = error; committed = (data ?? []).length;
    }
    if (updErr) throw new Error(updErr.message);
    if (committed === 0) {
      // The row moved under this batch — a rev-up re-pointed it, it was
      // deleted, or the claim was lost. What this batch wrote describes a
      // file the row no longer names: withdraw it, and never touch the row.
      const left = await withdrawOrRequeue();
      if (left) throw new Error(`superseded (the document moved before this batch committed), and ${left}`);
      return idle(cur as unknown as Record<string, unknown>, { superseded: true });
    }
    released = leased;

    // The Bridge and the mention pass, on both the interactive and the cron
    // paths (and on an accepted partial index — the route).
    if (done) await onDocumentReady(cur);

    if (!leased && (visionPages > 0 || genStart)) {
      // Pre-20261122 database: the running total the UI shows ("14 pages
      // read by AI vision") is kept the old way. Best-effort: a pre-migration
      // DB (no column) simply doesn't show the count. Under a claim it rides
      // the commit above instead. A generation's first batch starts it over.
      const { data: now } = await supabaseAdmin
        .from("knowledge_documents").select("vision_pages").eq("id", cur.id).maybeSingle();
      await supabaseAdmin.from("knowledge_documents")
        .update({ vision_pages: (genStart ? 0 : Number(now?.vision_pages ?? 0)) + visionPages })
        .eq("id", cur.id).eq("file_key", cur.file_key)
        .then(() => undefined, () => undefined);
    }

    return {
      done, pageCount,
      pagesIndexed: reached,
      resumeAt: reached,
      pagesReadable: Math.max(0, reached - failedAfter.length),
      emptyPages, emptyPagesTotal: leased ? emptyTotal : emptyPages,
      visionPages, visionBudgetSpent, stoppedForTime,
      visionFailedPages: failedAfter, visionError, visionRetryAttempts: attempted,
      busy: false, retryAfterMs: null, superseded: false,
      // A commit that finished a retry round says when the rest is tried.
      visionRetryBlocked: false, visionRetryMessage: roundBackoff?.message ?? null, visionRetryAfter: roundBackoff?.after ?? null,
      failureRetryBlocked: false, failureRetryMessage: null, failureRetryAfter: null, retryNowError: null,
      legacy: !leased, notPdf: null,
    };
  } catch (e) {
    // A real failure leaves carrying what this batch read, so the caller's
    // failure write (markIngestFailed) lands only on that row.
    if (e instanceof IngestBatchError) throw e;
    throw new IngestBatchError(e instanceof Error ? e.message : String(e), readOf(cur));
  } finally {
    if (leased && !released) await releaseIngestLease(doc.id, driver);
  }
}

/** Background drain used by the maintenance cron: keep ingesting queued
 *  (pending/stale) documents until the page budget or deadline runs out.
 *  Errors mark the row and continue — one broken PDF must not starve the
 *  queue. */
/** Background vision, sponsored by the document's UPLOADER: adding a
 *  document to a library IS the request to index it, so textless pages read
 *  on the uploader's own key — behind exactly the interactive gates
 *  (allowlisted provider, signed agreement, monthly cap) and metered to
 *  them. Returns no context when any gate fails; the caller then decides
 *  between text-only indexing and leaving the document queued. */
async function loadSponsorVision(
  doc: KnowledgeDocRow,
  onUsage: (usage: { inputTokens: number; outputTokens: number }, model: string) => void,
): Promise<{ ctx?: VisionContext; forceAllPages: boolean }> {
  const { data: libRow } = await supabaseAdmin
    .from("knowledge_libraries").select("ai_features")
    .eq("id", doc.library_id).maybeSingle();
  const forceAllPages =
    ((libRow?.ai_features ?? {}) as Record<string, unknown>).visionAllPages === true;

  const sponsor = doc.created_by ?? null;
  if (!sponsor) return { forceAllPages };
  const { data: conn } = await supabaseAdmin
    .from("ai_connections").select("provider, model, api_key")
    .eq("org_id", doc.org_id).eq("user_id", sponsor).maybeSingle();
  if (!conn || !ALLOWED_PROVIDERS.includes(conn.provider as AiProviderId)) {
    return { forceAllPages };
  }
  {
    const { data: agree, error: agreeError } = await supabaseAdmin
      .from("ai_key_agreements").select("id")
      .eq("org_id", doc.org_id).eq("user_id", sponsor)
      .eq("scope", "use").eq("agreement_version", AGREEMENT_VERSION).limit(1);
    const tableMissing = !!agreeError && (agreeError.code === "42P01" || /does not exist/i.test(agreeError.message));
    if (!tableMissing && (agree ?? []).length === 0) return { forceAllPages };
  }
  // GOV-4: an unreadable ledger withholds the vision context only — the
  // caller indexes text-only (or files a read-every-page library behind), and
  // the drain goes on to the next document instead of ending the run.
  const ledger = await Promise.all([
    getMonthUsage(doc.org_id, sponsor),
    getCapUsd(doc.org_id, sponsor),
  ]).catch((e: unknown) => { if (isAiUsageUnavailable(e)) return null; throw e; });
  if (!ledger) return { forceAllPages };
  const [spent, cap] = ledger;
  if (cap > 0 && spent.spentUsd >= cap) return { forceAllPages };

  return {
    forceAllPages,
    ctx: {
      provider: conn.provider as AiProviderId,
      model: conn.model as string,
      apiKey: openAiKey(conn.api_key as string),
      budgetPages: 4,                       // per batch — same as interactive
      forceAllPages,
      instructions: await loadOrgInstructionsBlock(supabaseAdmin, doc.org_id, "equipment"),
      onUsage,
    },
  };
}

export async function drainKnowledgeIngestQueue(opts: {
  maxPages: number;
  deadlineMs: number;
}): Promise<{ docsTouched: number; pagesIndexed: number; completed: number; errors: string[] }> {
  const out = { docsTouched: 0, pagesIndexed: 0, completed: 0, errors: [] as string[] };
  // 'indexing' is also the state an interactive driver leaves a row in
  // between its batches, so a row someone holds the claim on is skipped
  // here rather than raced (ING-2). The queue is twenty rows a run, across
  // every org: never-stamped rows (work no one has looked at yet) first,
  // then the oldest vision_retry_after. A document whose failed vision pages
  // wait on a retry (ING-6) stays 'indexing' too, and every row this run
  // meets but cannot work on is re-stamped to now, behind anything that
  // lapsed before it: a park (a keyless one skips its write only while its
  // stamp is under half an hour old), and a row in a read-every-page
  // library with no sponsored key (fileBehind, below) — which used to be
  // skipped untouched, so twenty never-stamped ones held the head for good.
  // So no row the drain cannot work on holds the head: they rotate through
  // it twenty at a time. A lapsed failure (ING-8) comes up once the rows
  // ahead of it have had their turn — the never-stamped work, then the rows
  // stamped before it lapsed: on run floor(N / 20) + 1 after it lapsed for
  // N such rows, or later when a run's page budget or time ends before its
  // twentieth row. A pre-20261122 database has neither column: the legacy
  // selector, in upload order.
  const cutoff = new Date(Date.now() - INGEST_LEASE_TTL_MS).toISOString();
  const select = (claimFilter: boolean) => {
    let q = supabaseAdmin
      .from("knowledge_documents")
      .select("*")
      .in("status", ["pending", "stale", "indexing"]);
    if (claimFilter) {
      q = q.or(`ingest_claimed_at.is.null,ingest_claimed_at.lt."${cutoff}"`)
        .order("vision_retry_after", { ascending: true, nullsFirst: true });
    }
    return q.order("created_at", { ascending: true }).limit(20);
  };
  let { data: queued, error } = await select(true);
  let hasStamp = true;
  if (error && isMissingColumn(error)) { hasStamp = false; ({ data: queued, error } = await select(false)); }
  if (error || !queued) return out;

  /** A row this run cannot work on files behind everything that lapsed
   *  before now, as a park does: its stamp moves to now. A compare-and-set
   *  on the stamp as read, on a row no one holds the claim on, so it never
   *  overwrites a writer's — and a back-off still in force already files it
   *  behind now, and is never shortened. Checked: a stamp that cannot be
   *  written is reported. */
  const fileBehind = async (d: KnowledgeDocRow): Promise<void> => {
    if (!hasStamp) return;
    const nowMs = Date.now();
    const at = Date.parse(String(d.vision_retry_after ?? ""));
    if (Number.isFinite(at) && at > nowMs) return;
    let q = supabaseAdmin.from("knowledge_documents").update({ vision_retry_after: new Date(nowMs).toISOString() })
      .eq("id", d.id).eq("file_key", d.file_key)
      .or(`ingest_claimed_at.is.null,ingest_claimed_at.lt."${cutoff}"`);
    q = d.vision_retry_after == null ? q.is("vision_retry_after", null) : q.eq("vision_retry_after", d.vision_retry_after);
    const { error: stampErr } = await q;
    if (stampErr) out.errors.push(`${d.name}: could not move it behind newer work in the queue: ${stampErr.message}`);
  };

  let budget = opts.maxPages;
  for (const doc of queued as KnowledgeDocRow[]) {
    if (budget <= 0 || Date.now() > opts.deadlineMs) break;

    // Vision on the uploader's key, same gates as interactive. A library
    // marked "read every page with vision" must NOT be consumed text-only
    // when no sponsored key is available — that would permanently index
    // drawings as empty pages. Leave it queued for an interactive driver,
    // filed behind what lapsed before now (a mirror has no uploader, so no
    // sponsor ever: left where it was, it would come first every night).
    const visionUsage: AiUsage = { inputTokens: 0, outputTokens: 0 };
    let visionModel = "";
    const sponsor = await loadSponsorVision(doc, (u, model) => {
      visionUsage.inputTokens += u.inputTokens;
      visionUsage.outputTokens += u.outputTokens;
      visionModel = model;
    });
    if (!sponsor.ctx && sponsor.forceAllPages) { await fileBehind(doc); continue; }

    out.docsTouched++;
    let row: KnowledgeDocRow = doc;
    try {
      // Batch until this doc finishes or budget/deadline runs out.
      for (;;) {
        const waitingBefore = pageList(row.vision_failed_pages).length;
        // Same deadline the drain itself respects: a batch that overruns the
        // cron's window would be killed mid-flight and lose its pages.
        const res = await ingestKnowledgeDocBatch(row, sponsor.ctx, opts.deadlineMs);
        // Someone else is indexing it, or it moved under us: not ours now.
        // Failed vision pages this run cannot retry: said on the row, and
        // the document keeps its index — never an error (ING-6). A failed
        // batch still waiting out its back-off (ING-8): a later run.
        if (res.busy || res.superseded || res.visionRetryBlocked || res.failureRetryBlocked) break;
        if (res.notPdf) {
          // The same refusal the interactive route gives (ING-9): an upload
          // leaves nothing behind, a mirror is marked with the message —
          // unless the row was re-pointed since the file was checked.
          const refused = await refuseNonPdf(doc as unknown as Record<string, unknown>, res.notPdf, null, res.notPdfRead);
          if (!refused.superseded) out.errors.push(`${doc.name}: ${refused.message}${refused.error ? ` (${refused.error})` : ""}`);
          break;
        }
        const processed = res.resumeAt - (row.pages_indexed ?? 0);
        // A vision-retry batch (ING-6) does not move the resume point — the
        // failed pages it read back are its progress. Counting only the
        // resume point read every successful retry as "stuck" and stopped
        // after one batch: four pages a day for a drawing set waiting on
        // forty.
        const reread = Math.max(0, waitingBefore - res.visionFailedPages.length);
        // A retry batch whose tries all failed again still moved the queue
        // on (those pages go to the back; the next batch tries the ones
        // behind them) — that is work too, and it spent vision calls.
        budget -= processed + Math.max(reread, res.visionRetryAttempts);
        out.pagesIndexed += processed + reread;
        if (res.done) { out.completed++; break; }
        // Nothing moved = out of time (or stuck). Either way, hand the rest
        // to the next run rather than spinning on the same page range.
        if ((processed + reread <= 0 && res.visionRetryAttempts <= 0) || budget <= 0 || Date.now() > opts.deadlineMs) break;
        row = {
          ...row, pages_indexed: res.resumeAt, page_count: res.pageCount, status: "indexing",
          vision_failed_pages: res.visionFailedPages,
          // This batch did work (a no-op stopped the loop above), so its
          // commit zeroed the failure count; the copy follows it, so a later
          // failure write compares against what the row holds.
          ...("ingest_failures" in row ? { ingest_failures: 0 } : {}),
        };
      }
    } catch (e) {
      out.errors.push(`${doc.name}: ${(e as Error).message}`);
      // Only onto the row the failing batch read (ING-1).
      await markIngestFailed(row, e).catch(() => undefined);
    }
    if (visionUsage.inputTokens + visionUsage.outputTokens > 0 && sponsor.ctx && doc.created_by) {
      await recordAskUsage({
        orgId: doc.org_id, userId: doc.created_by,
        provider: sponsor.ctx.provider, model: visionModel || sponsor.ctx.model,
        usage: visionUsage, ok: true, op: "knowledgeVision",
      }).catch(() => undefined);
    }
  }
  return out;
}
