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
// document. The rev-up refresh and the drawing rebuild take the SAME claim
// through resetKnowledgeIndex below. The claim lasts one batch, never a
// document, so the self-imposed deadline below still bounds everything.

import { randomUUID } from "node:crypto";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { r2, R2_BUCKET } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { openAiKey } from "@/lib/ai/keyVault";
import { chunkPageText, splitPageIntoSections, ensurePdfPolyfills, CAPTION_RE,
  sanitizeStorageText, truncateSafe, splitTables, pageLinesFromTextItems, pageTail, carriedTailMarker,
  chunkerVersionOf, CHUNKER_LEGACY, CHUNKER_TABLE_AWARE, type ChunkerVersion, type PdfTextItem,
} from "@/lib/knowledgeText";
import {
  isDrawingLikePage, extractEquipmentTags, extractDrawingRefs, extractTitleBlock,
  parseOpcBoxes, pageNeedsVision, TEXTLESS_PAGE_MAX_CHARS,
} from "@/lib/drawingText";
import { transcribePageImage } from "@/lib/knowledgeVision";
import { isTimeoutError, type AiProviderId } from "@/lib/ai/providerCall";
import { ALLOWED_PROVIDERS, AGREEMENT_VERSION, type AiUsage } from "@/lib/ai/pricing";
import { getMonthUsage, getCapUsd, recordAskUsage } from "@/lib/ai/usageServer";
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
  /** Pages the index actually holds: the resume point less the pages whose
   *  AI-vision read failed and waits for a retry (ING-6). What a progress
   *  bar shows. */
  pagesIndexed: number;
  /** Where the next batch starts — knowledge_documents.pages_indexed. */
  resumeAt: number;
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
  /** Another driver holds this document's claim — nothing was done (ING-2). */
  busy: boolean;
  /** The row moved under this batch (re-pointed at a new revision, deleted,
   *  or the claim was lost): its writes were withdrawn (ING-1). */
  superseded: boolean;
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

const pageList = (v: unknown): number[] =>
  Array.isArray(v) ? [...new Set(v.map(Number).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b) : [];

/** The columns 20261122 adds to knowledge_documents — stripped from a write
 *  on a database that has not applied it yet. */
const INGEST_COLUMNS_20261122 = [
  "ingest_claimed_by", "ingest_claimed_at", "empty_pages", "vision_failed_pages",
  "vision_partial_accepted", "chunk_version",
];

// ── The shared reset (ING-3 / DWG-1 / ING-12) ─────────────────────────────

export interface KnowledgeIndexReset {
  /** Documents whose derived index is gone and that are queued ('stale'). */
  reset: string[];
  /** Documents another driver was indexing at that moment — left untouched;
   *  a later pass resets them. */
  busy: string[];
  errors: string[];
}

/** Everything the index derives from a file, zeroed: the row says "nothing
 *  read yet" and every counter starts again for the new index generation. */
const RESET_ROW = {
  status: "stale", error: null, pages_indexed: 0, page_count: null, last_section: null,
  vision_pages: 0, empty_pages: 0, vision_failed_pages: [] as number[],
  vision_partial_accepted: false, chunk_version: null,
};

/** THE reset of a knowledge document's derived index — the one both the
 *  rev-up refresh (lib/knowledgeSourceSync.ts) and the drawing
 *  intelligence "Rebuild index" call, so neither can forget a table again.
 *  Under the document's ingest claim, in order: every chunk (and with it
 *  the chunk's embedding), every page entity (tags, refs, sheet identity,
 *  anchors, vision positions), the MACHINE-derived entity mentions (a
 *  person's explicit pin survives — a re-index is not a decision), and —
 *  when the file itself changed — the cached line traces drawn over the old
 *  sheet. Then the row: 'stale', counters to zero (vision_pages included —
 *  ING-12), plus `rowUpdate` (the rev-up's new file_key / version / rev).
 *  Deletes run first and the row last, so a failure leaves the row pointing
 *  at the old version and the next pass simply repeats the whole reset. A
 *  document being indexed right now is reported `busy`, never reset under
 *  the batch writing it. */
export async function resetKnowledgeIndex(
  documentIds: string[],
  opts: {
    rowUpdate?: (documentId: string) => Record<string, unknown>;
    /** The file changed (rev-up): cached traces of the old sheet go too. */
    purgeLineTraces?: boolean;
  } = {},
): Promise<KnowledgeIndexReset> {
  const out: KnowledgeIndexReset = { reset: [], busy: [], errors: [] };
  for (const id of documentIds) {
    const driver = `reset:${randomUUID()}`;
    let lease: IngestLease;
    try {
      lease = await claimIngestLease(id, driver);
    } catch (e) {
      out.errors.push(`${id}: ${(e as Error).message}`);
      continue;
    }
    if (lease.kind === "busy") { out.busy.push(id); continue; }
    if (lease.kind === "gone") continue;
    const claimedRow = lease.kind === "claimed" ? lease.row : null;
    const leased = claimedRow !== null;
    const fail = async (what: string, message: string | undefined) => {
      out.errors.push(`${id}: ${what}: ${message ?? "failed"}`);
      if (leased) await releaseIngestLease(id, driver);
    };

    const { error: chunkErr } = await supabaseAdmin
      .from("knowledge_chunks").delete().eq("document_id", id);
    if (chunkErr) { await fail("chunks", chunkErr.message); continue; }
    const { error: entErr } = await supabaseAdmin
      .from("knowledge_page_entities").delete().eq("document_id", id);
    if (entErr && !isMissingTable(entErr)) { await fail("page entities", entErr.message); continue; }
    const { error: menErr } = await supabaseAdmin
      .from("entity_mentions").delete().eq("knowledge_document_id", id).eq("is_explicit", false);
    if (menErr && !isMissingTable(menErr)) { await fail("mentions", menErr.message); continue; }
    if (opts.purgeLineTraces) {
      const { error: trErr } = await supabaseAdmin
        .from("knowledge_line_traces").delete().eq("document_id", id);
      if (trErr && !isMissingTable(trErr)) { await fail("line traces", trErr.message); continue; }
    }

    const full: Record<string, unknown> = { ...RESET_ROW, ...(opts.rowUpdate?.(id) ?? {}) };
    let updErr: DbError = null;
    let wrote = 0;
    if (claimedRow) {
      const known = new Set(Object.keys(claimedRow));
      const update = Object.fromEntries(Object.entries({
        ...full, ingest_claimed_by: null, ingest_claimed_at: null,
      }).filter(([k]) => known.has(k)));
      const { data, error } = await supabaseAdmin.from("knowledge_documents")
        .update(update).eq("id", id).eq("ingest_claimed_by", driver).select("id");
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
        const { data, error } = await supabaseAdmin.from("knowledge_documents")
          .update(update).eq("id", id).select("id");
        updErr = error; wrote = (data ?? []).length;
        if (!error || !isMissingColumn(error)) break;
      }
    }
    if (updErr) { await fail("row", updErr.message); continue; }
    if (wrote === 0) { out.errors.push(`${id}: row: the claim was lost before the reset committed`); continue; }
    out.reset.push(id);
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

// ── Re-index a library with a chosen chunker (ING-4 / ING-7) ──────────────

export interface LibraryReindex extends KnowledgeIndexReset {
  chunker: ChunkerVersion;
  /** Pages the previous index read with AI vision — read (and billed)
   *  again by the re-index. Said up front. */
  visionPagesToReread: number;
}

/** The explicit per-library switch between chunkers: record the library's
 *  choice, then reset every one of its documents through the shared reset
 *  so each re-indexes from its first page under the new chunker. Never run
 *  automatically — every chunk boundary in the library changes, and vision-
 *  read pages are read again. The meaning (embedding) index follows the new
 *  chunks as its own pipeline re-embeds them. */
export async function reindexLibraryChunks(libraryId: string, chunker: ChunkerVersion): Promise<LibraryReindex> {
  const { error: libErr } = await supabaseAdmin
    .from("knowledge_libraries").update({ chunk_version: chunker }).eq("id", libraryId);
  if (libErr) throw new Error(isMissingColumn(libErr)
    ? "Choosing a chunker needs migration 20261122_intel_roundG_ingest_integrity.sql — apply it first."
    : `library: ${libErr.message}`);
  const ids: string[] = [];
  let visionPagesToReread = 0;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin.from("knowledge_documents")
      .select("id, vision_pages").eq("library_id", libraryId)
      .order("id", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`documents: ${error.message}`);
    const page = (data ?? []) as Array<{ id: string; vision_pages: number | null }>;
    for (const d of page) { ids.push(d.id); visionPagesToReread += Number(d.vision_pages ?? 0); }
    if (page.length < 1000) break;
  }
  const res = await resetKnowledgeIndex(ids);
  return { ...res, chunker, visionPagesToReread };
}

/** Thrown inside a batch when its writes collide with another writer's
 *  (duplicate chunk key, the document row deleted underneath it): the batch
 *  withdraws what it wrote and reports `superseded` rather than erroring
 *  the document (ING-2 criterion 3). */
class IngestSuperseded extends Error {}

/** The plain-language refusal when failed vision pages cannot be retried. */
export function visionRetryMessage(pages: number[], cause: string | null): string {
  const list = pages.slice(0, 12).join(", ") + (pages.length > 12 ? ", …" : "");
  const what = `AI vision could not read ${pages.length} page${pages.length === 1 ? "" : "s"} (p. ${list})`;
  return cause
    ? `${what}: ${cause}. Re-run indexing to retry them, or accept the partial index.`
    : `${what}, and retrying needs an AI key with budget left. Add one in AI settings and re-run indexing, or accept the partial index.`;
}

/** Ingest the next PAGE_BATCH pages of one knowledge document. Throws on
 *  failure — callers decide whether to mark the row errored (the API route
 *  does; the cron records and moves on). Never throws for contention: a
 *  document someone else is indexing comes back `busy`, a document that
 *  moved under the batch comes back `superseded`. */
export async function ingestKnowledgeDocBatch(
  doc: KnowledgeDocRow,
  vision?: VisionContext,
  /** Wall-clock stop (epoch ms). EVERY write in this function happens after
   *  the page loop, so an invocation killed by the platform loses the whole
   *  batch and pages_indexed never advances — the client then re-POSTs the
   *  same range forever and indexing stalls at zero. Stopping ourselves,
   *  early and cleanly, is what makes progress durable. */
  deadlineMs?: number,
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
      pagesIndexed: Math.max(0, resumeAt - failedNow.length),
      resumeAt,
      emptyPages: 0,
      emptyPagesTotal: Number(row.empty_pages ?? 0),
      visionPages: 0, visionBudgetSpent: false, stoppedForTime: false,
      visionFailedPages: failedNow, visionError: null,
      busy: false, superseded: false,
      ...flags,
    };
  };
  if (lease.kind === "busy") return idle(lease.row, { busy: true });
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

    // Pull the PDF from R2 (each batch re-downloads; simple and stateless).
    const obj = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: cur.file_key }));
    const bytes = new Uint8Array(await new Response(obj.Body as ReadableStream).arrayBuffer());

    const { getDocumentProxy, renderPageAsImage } = await import("unpdf");
    const pdf = await getDocumentProxy(bytes);
    const pageCount = pdf.numPages;

    const from = Number(cur.pages_indexed ?? 0);           // 0-based next page
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
    const genStart = from === 0;
    const failedBefore = genStart ? [] : pageList(cur.vision_failed_pages);
    const failed = new Set<number>(failedBefore);
    const accepted = !genStart && cur.vision_partial_accepted === true;
    const retryMode = from >= pageCount && failedBefore.length > 0 && !accepted;
    const baseVisionPages = genStart ? 0 : Number(cur.vision_pages ?? 0);
    const baseEmptyPages = genStart ? 0 : Number(cur.empty_pages ?? 0);

    // Which chunker (ING-4 / ING-7): a document keeps the one it started
    // with — its chunk boundaries never mix — and a document (re)starting at
    // its first page takes its library's current choice. Unclaimed (a
    // database without 20261122) there is nowhere to record it: chunker 1.
    let chunkVersion: ChunkerVersion = chunkerVersionOf(cur.chunk_version);
    if (claimed && !retryMode && from === 0) {
      const { data: lib, error: libErr } = await supabaseAdmin
        .from("knowledge_libraries").select("chunk_version").eq("id", cur.library_id).maybeSingle();
      chunkVersion = libErr ? CHUNKER_LEGACY : chunkerVersionOf((lib as { chunk_version?: unknown } | null)?.chunk_version);
    }
    const tableAware = chunkVersion === CHUNKER_TABLE_AWARE;
    /** Chunker 2 carries the unfinished sentence at the foot of a page into
     *  the next (ING-7). Across a batch boundary it is read back from the
     *  last chunk stored for the previous page — prose chunks are single
     *  lines, so a chunk with a line break is a table and carries nothing. */
    const storedTail = async (page: number): Promise<{ text: string; fromPage: number } | null> => {
      if (!tableAware || page < 1) return null;
      const { data } = await supabaseAdmin.from("knowledge_chunks")
        .select("content").eq("document_id", cur.id).eq("page", page)
        .order("seq", { ascending: false }).limit(1);
      const last = ((data ?? []) as Array<{ content: string }>)[0]?.content ?? "";
      const text = last.includes("\n") ? "" : pageTail(last);
      return text ? { text, fromPage: page } : null;
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

    /** Chunk one read page. Every row says how its text was obtained —
     *  'text' (the PDF's own text layer) or 'vision' (an AI transcription,
     *  with the model that wrote it) — GOV-9. Chunker 2 keeps line
     *  structure (tables stay whole — ING-4) and opens the page with the
     *  previous page's unfinished sentence, marked with where it came from
     *  (ING-7); it also returns this page's own unfinished sentence. */
    const chunkRowsFor = (p: number, read: PageRead, carry: string | null, carried: { text: string; fromPage: number } | null) => {
      const { segments, lastSection } = tableAware
        ? splitPageIntoSections(read.chunkLines, carry, { keepLines: true })
        : splitPageIntoSections(read.lines, carry);
      let tail = "";
      if (tableAware && segments.length > 0) {
        // Only a page that continues the same section continues a sentence.
        if (carried && segments[0].section === carry) {
          segments[0] = { ...segments[0], text: `${carriedTailMarker(carried.fromPage)} ${carried.text}\n${segments[0].text}` };
        }
        const parts = splitTables(segments[segments.length - 1].text);
        const last = parts[parts.length - 1];
        if (last?.kind === "prose") tail = pageTail(last.text);
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
      //    pages whose vision call failed. No key = nothing can retry them,
      //    and that is said out loud rather than parked forever.
      if (!vision) throw new Error(visionRetryMessage(failedBefore, null));
      let attempted = 0;
      for (const p of failedBefore) {
        if (deadlineMs && Date.now() >= deadlineMs) { stoppedForTime = true; break; }
        const step = await readPage(p, true);
        if (step.stop) {
          if (step.stop === "time") stoppedForTime = true; else visionBudgetSpent = true;
          break;
        }
        attempted++;
        const read = step.page;
        if (read.visionFailed) { visionError = read.visionFailed; continue; }
        failed.delete(p);
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
      if (attempted > 0 && retried.size === 0) {
        // Every retry this pass failed again: stop and say so — the caller
        // records it on the row; a person re-runs or accepts the partial.
        throw new Error(visionRetryMessage(failedBefore, visionError));
      }
    }

    // Everything below advances only as far as the last FULLY processed page
    // (a vision-budget stop can end the batch early).
    const reached = retryMode ? from : lastCompletedPage;
    const rewrite = retryMode ? [...retried.keys()] : [];
    const touched = retryMode ? rewrite.length > 0 : reached > from;

    // Rows this batch wrote — withdrawn if it turns out to be superseded.
    const insertedChunkIds: string[] = [];
    const insertedEntityIds: string[] = [];
    const withdraw = async () => {
      for (const [table, ids] of [["knowledge_chunks", insertedChunkIds], ["knowledge_page_entities", insertedEntityIds]] as const) {
        for (let i = 0; i < ids.length; i += 200) {
          await supabaseAdmin.from(table).delete().in("id", ids.slice(i, i + 200));
        }
      }
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
        // that are still there is how duplicates were born.
        let del = supabaseAdmin.from("knowledge_chunks").delete().eq("document_id", cur.id);
        del = retryMode ? del.in("page", rewrite) : del.gte("page", from + 1).lte("page", reached);
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
        del = retryMode ? del.in("page", rewrite) : del.gte("page", from + 1).lte("page", reached);
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
        await withdraw();
        return idle(cur as unknown as Record<string, unknown>, { superseded: true });
      }
      throw e;
    }

    // ── Commit: compare-and-set on what this batch read (ING-1) ──────────
    const failedAfter = [...failed].sort((a, b) => a - b);
    const done = reached >= pageCount && (failedAfter.length === 0 || accepted);
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
    const cas = (q: ReturnType<ReturnType<typeof supabaseAdmin.from>["update"]>) => {
      // The row must still be the file and version this batch read — a
      // rev-up re-points both — and, under a claim, still ours and still
      // where this batch started.
      let out = q.eq("id", cur.id).eq("file_key", cur.file_key);
      if (cur.source_version_id !== undefined) {
        out = cur.source_version_id === null ? out.is("source_version_id", null) : out.eq("source_version_id", cur.source_version_id);
      }
      if (leased) out = out.eq("ingest_claimed_by", driver).eq("pages_indexed", from);
      return out;
    };
    if (claimed) {
      const known = new Set(Object.keys(claimed));
      const full: Record<string, unknown> = {
        ...docUpdate,
        vision_pages: baseVisionPages + visionPages,
        empty_pages: emptyTotal,
        vision_failed_pages: failedAfter,
        vision_partial_accepted: accepted,
        chunk_version: chunkVersion,
        ingest_claimed_by: null, ingest_claimed_at: null,
      };
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
      await withdraw();
      return idle(cur as unknown as Record<string, unknown>, { superseded: true });
    }
    released = leased;

    if (done) {
      // The drawing→equipment bridge: freshly extracted tags flow toward the
      // source document's equipment column + the registry. Fire-and-forget and
      // dynamically imported — bridge failures can NEVER break indexing, and
      // this fires on both the interactive and cron ingest paths.
      void import("@/lib/equipmentBridgeServer")
        .then((m) => m.computeForKnowledgeDoc(supabaseAdmin, cur.id))
        .catch(() => undefined);
    }

    if (!leased && (visionPages > 0 || genStart)) {
      // Pre-20261122 database: the running total the UI shows ("14 pages
      // read by AI vision") is kept the old way. Best-effort: a pre-migration
      // DB (no column) simply doesn't show the count. Under a claim it rides
      // the commit above instead. A generation's first batch starts it over.
      const { data: now } = await supabaseAdmin
        .from("knowledge_documents").select("vision_pages").eq("id", cur.id).maybeSingle();
      await supabaseAdmin.from("knowledge_documents")
        .update({ vision_pages: (genStart ? 0 : Number(now?.vision_pages ?? 0)) + visionPages })
        .eq("id", cur.id)
        .then(() => undefined, () => undefined);
    }

    return {
      done, pageCount,
      pagesIndexed: Math.max(0, reached - failedAfter.length),
      resumeAt: reached,
      emptyPages, emptyPagesTotal: leased ? emptyTotal : emptyPages,
      visionPages, visionBudgetSpent, stoppedForTime,
      visionFailedPages: failedAfter, visionError,
      busy: false, superseded: false,
    };
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
  const [spent, cap] = await Promise.all([
    getMonthUsage(doc.org_id, sponsor),
    getCapUsd(doc.org_id, sponsor),
  ]);
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
  // here rather than raced (ING-2). A pre-20261122 database has no claim
  // columns: the legacy selector.
  const cutoff = new Date(Date.now() - INGEST_LEASE_TTL_MS).toISOString();
  const select = (claimFilter: boolean) => {
    let q = supabaseAdmin
      .from("knowledge_documents")
      .select("*")
      .in("status", ["pending", "stale", "indexing"]);
    if (claimFilter) q = q.or(`ingest_claimed_at.is.null,ingest_claimed_at.lt."${cutoff}"`);
    return q.order("created_at", { ascending: true }).limit(20);
  };
  let { data: queued, error } = await select(true);
  if (error && isMissingColumn(error)) ({ data: queued, error } = await select(false));
  if (error || !queued) return out;

  let budget = opts.maxPages;
  for (const doc of queued as KnowledgeDocRow[]) {
    if (budget <= 0 || Date.now() > opts.deadlineMs) break;

    // Vision on the uploader's key, same gates as interactive. A library
    // marked "read every page with vision" must NOT be consumed text-only
    // when no sponsored key is available — that would permanently index
    // drawings as empty pages. Leave it queued for an interactive driver.
    const visionUsage: AiUsage = { inputTokens: 0, outputTokens: 0 };
    let visionModel = "";
    const sponsor = await loadSponsorVision(doc, (u, model) => {
      visionUsage.inputTokens += u.inputTokens;
      visionUsage.outputTokens += u.outputTokens;
      visionModel = model;
    });
    if (!sponsor.ctx && sponsor.forceAllPages) continue;

    out.docsTouched++;
    try {
      // Batch until this doc finishes or budget/deadline runs out.
      let row: KnowledgeDocRow = doc;
      for (;;) {
        // Same deadline the drain itself respects: a batch that overruns the
        // cron's window would be killed mid-flight and lose its pages.
        const res = await ingestKnowledgeDocBatch(row, sponsor.ctx, opts.deadlineMs);
        // Someone else is indexing it, or it moved under us: not ours now.
        if (res.busy || res.superseded) break;
        const processed = res.resumeAt - (row.pages_indexed ?? 0);
        budget -= processed;
        out.pagesIndexed += processed;
        if (res.done) { out.completed++; break; }
        // No pages moved = out of time (or stuck). Either way, hand the rest
        // to the next run rather than spinning on the same page range.
        if (processed <= 0 || budget <= 0 || Date.now() > opts.deadlineMs) break;
        row = { ...row, pages_indexed: res.resumeAt, page_count: res.pageCount, status: "indexing" };
      }
    } catch (e) {
      const message = (e as Error).message;
      out.errors.push(`${doc.name}: ${message}`);
      await supabaseAdmin.from("knowledge_documents")
        .update({ status: "error", error: message.slice(0, 500) })
        .eq("id", doc.id)
        .then(() => undefined, () => undefined);
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
