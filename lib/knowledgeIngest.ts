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

import { createHash } from "node:crypto";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { r2, R2_BUCKET } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { openAiKey } from "@/lib/ai/keyVault";
import { chunkPageText, splitPageIntoSections, ensurePdfPolyfills, CAPTION_RE,
  sanitizeStorageText, truncateSafe,
} from "@/lib/knowledgeText";
import {
  isDrawingLikePage, extractEquipmentTags, extractDrawingRefs, extractTitleBlock,
  parseOpcBoxes, pageNeedsVision, TEXTLESS_PAGE_MAX_CHARS, tagKindOf,
} from "@/lib/drawingText";
import { transcribePageImage } from "@/lib/knowledgeVision";
import { isTimeoutError, callAiModel, type AiProviderId } from "@/lib/ai/providerCall";
import { ALLOWED_PROVIDERS, AGREEMENT_VERSION, type AiUsage } from "@/lib/ai/pricing";
import { getMonthUsage, getCapUsd, recordAskUsage } from "@/lib/ai/usageServer";
import { jobModel } from "@/lib/ai/jobModelsServer";
import { loadOrgInstructionsBlock } from "@/lib/aiInstructionsServer";
import { loadCodebookAdmin } from "@/lib/codebookServer";
import { readAutoRead, pagesLeft, withPagesUsed } from "@/lib/estate/autoRead";

export const PAGE_BATCH = 50;

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** Vision transcription context. Present only on the user-driven ingest
 *  path: transcription spends the TRIGGERING user's own key, so a
 *  background job never quietly bills someone. */
export interface VisionContext {
  provider: AiProviderId;
  model: string;
  /** The model scanned pages are read on (AI settings → Reading drawings &
   *  scans); unset = the cheap reading tier. */
  readingModel?: string;
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
  pagesIndexed: number;
  emptyPages: number;
  /** Pages read by AI vision in this batch (no text layer). */
  visionPages: number;
  /** Pages whose stored transcript (this copy's, or another copy of the
   *  same bytes) was reused instead of paying vision again. */
  reusedPages: number;
  /** True when the batch stopped early because the vision budget ran out —
   *  the caller simply calls again to continue. */
  visionBudgetSpent: boolean;
  /** True when the batch stopped early because it was running out of
   *  invocation time. Progress up to the last finished page is committed;
   *  the caller just calls again. Not an error. */
  stoppedForTime: boolean;
}

/** Time to leave on the clock before starting a vision page. Rendering a
 *  dense E-size drawing and transcribing it is tens of seconds, and a page
 *  begun too late is work the platform throws away. */
const VISION_PAGE_RESERVE_MS = 25_000;
/** The drawing reader sends five images to the person's own model. */
const DRAWING_PAGE_RESERVE_MS = 45_000;
/** The FIRST vision page of an invocation needs only this much. A request
 *  gets 45s in all, and some of it is spent fetching and opening the PDF —
 *  so demanding the full drawing reserve up front meant the first page of a
 *  drawing never started, no request ever made progress, and every P&ID
 *  sat "indexing" forever, retried at every login. The model call is
 *  itself bounded by the deadline, and a page it can't finish is kept as
 *  text, so starting it can't lose the batch. */
const FIRST_PAGE_RESERVE_MS = 20_000;

/** May a vision page start now? The first page of an invocation needs only
 *  FIRST_PAGE_RESERVE_MS; later pages need the full reserve for their kind. */
export function visionHasTime(o: { now: number; deadlineMs?: number | null; firstOfBatch: boolean; drawingSet: boolean }): boolean {
  if (!o.deadlineMs) return true;
  const reserve = o.drawingSet ? DRAWING_PAGE_RESERVE_MS : VISION_PAGE_RESERVE_MS;
  return o.now + (o.firstOfBatch ? Math.min(reserve, FIRST_PAGE_RESERVE_MS) : reserve) <= o.deadlineMs;
}

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
};

/** Ingest the next PAGE_BATCH pages of one knowledge document. Throws on
 *  failure — callers decide whether to mark the row errored (the API route
 *  does; the cron records and moves on). */
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

  // Pull the PDF from R2 (each batch re-downloads; simple and stateless).
  const obj = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: doc.file_key }));
  const bytes = new Uint8Array(await new Response(obj.Body as ReadableStream).arrayBuffer());

  const { getDocumentProxy, renderPageAsImage } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes);
  const pageCount = pdf.numPages;

  const from = Number(doc.pages_indexed ?? 0);           // 0-based next page
  const to = Math.min(from + PAGE_BATCH, pageCount);
  // A drawing set extracts on EVERY page. The sparse-text heuristic was
  // written for standards with the odd drawing inside; a CAD P&ID with a
  // full text layer carries thousands of characters and used to be skipped
  // as "prose" — every tag on it invisible, the registry empty.
  const { data: libFeat } = await supabaseAdmin.from("knowledge_libraries").select("ai_features").eq("id", doc.library_id).maybeSingle();
  const drawingSet = ((libFeat?.ai_features ?? {}) as Record<string, unknown>).drawingIntel === true;
  // The site's own equipment prefixes (Site codebook › Equipment types)
  // widen what the dashless reader accepts on a drawing.
  const knownPrefixes: string[] = drawingSet
    ? await loadCodebookAdmin(supabaseAdmin, doc.org_id).then((b) => b.equipmentTypes.flatMap((t) => t.meta.tagPrefixes ?? [])).catch(() => [])
    : [];

  // ── Bytes read once ──────────────────────────────────────────────────
  // Every copy carries its hash. What was already read for these bytes —
  // this copy on an earlier pass, or another copy of the same file in any
  // library — is reused page by page where vision would otherwise run, so
  // a transcript is paid for once. The cheap text pass still runs, so
  // positions and tags come out fresh.
  let fileHash: string | null = null;
  {
    const { data: me } = await supabaseAdmin.from("knowledge_documents").select("file_hash").eq("id", doc.id).maybeSingle();
    fileHash = ((me as { file_hash?: string | null } | null)?.file_hash) ?? null;
    if (!fileHash) {
      fileHash = createHash("sha256").update(bytes).digest("hex");
      await supabaseAdmin.from("knowledge_documents").update({ file_hash: fileHash }).eq("id", doc.id).then(() => undefined, () => undefined);
    }
  }
  const twinIds: string[] = [doc.id];
  if (fileHash) {
    const { data: twins } = await supabaseAdmin.from("knowledge_documents").select("id").eq("org_id", doc.org_id).eq("file_hash", fileHash).neq("id", doc.id).in("status", ["ready", "retired"]).limit(5);
    for (const t of (twins as Array<{ id: string }> | null) ?? []) twinIds.push(t.id);
  }
  const stored = new Map<number, string>();
  {
    const { data: prior } = await supabaseAdmin.from("knowledge_chunks").select("document_id, page, seq, content").in("document_id", twinIds).gte("page", from + 1).lte("page", to).order("seq", { ascending: true }).limit(4000);
    const byDocPage = new Map<string, string[]>();
    for (const c of (prior as Array<{ document_id: string; page: number; seq: number; content: string }> | null) ?? []) {
      const k = `${c.document_id}:${c.page}`;
      byDocPage.set(k, [...(byDocPage.get(k) ?? []), c.content]);
    }
    for (let p = from + 1; p <= to; p++) {
      for (const id of twinIds) { const parts = byDocPage.get(`${id}:${p}`); if (parts?.length) { stored.set(p, parts.join("\n")); break; } }
    }
  }
  let reusedPages = 0;
  let emptyPages = 0;
  let visionPages = 0;
  let visionBudgetSpent = false;
  let stoppedForTime = false;
  let lastCompletedPage = from;                          // for early stops
  const rows: Array<Record<string, unknown>> = [];
  // Section heading in force where the last batch left off — sections span
  // pages, so it persists on the document row between batches.
  let section: string | null = doc.last_section ?? null;
  let visionLeft = vision?.budgetPages ?? 0;

  const entityRows: Array<Record<string, unknown>> = [];
  for (let p = from + 1; p <= to; p++) {                 // pdf.js pages are 1-based
    if (deadlineMs && Date.now() >= deadlineMs) { stoppedForTime = true; break; }
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    // Rebuild LINES (not one long string): heading detection needs them.
    let lines: string[] = [];
    let buf = "";
    type TextItem = { str?: string; hasEOL?: boolean; transform?: number[] };
    for (const item of content.items as TextItem[]) {
      buf += item.str ?? "";
      if (item.hasEOL) { lines.push(buf.trim()); buf = ""; }
      else buf += " ";
    }
    if (buf.trim()) lines.push(buf.trim());
    // Broken font CMaps put LONE SURROGATES / control bytes in the text
    // layer; unsanitized they reach the chunk insert and Postgres refuses
    // the whole batch ("invalid input syntax for type json"). Scrub at the
    // source so every consumer (chunks, tags, captions) gets clean text.
    lines = lines.map(sanitizeStorageText);

    // ── VISION FALLBACK: this page can't be read from its text layer.
    //    AutoCAD SHX text plots as LINE-WORK (tags exist as strokes, not
    //    text objects) and scans have no text at all. A drawing can even
    //    look "readable" — a TrueType title block yields a few hundred
    //    characters while every tag stays invisible — so the decision uses
    //    tags-found, not just length (see pageNeedsVision). The transcript
    //    then flows through the SAME pipeline (sections → chunks → tags →
    //    refs), making the sheet fully searchable and citable.
    let visionRead = false;
    // Set when the drawing reader read this page: its structured reading
    // stands, and no pattern-matcher second-guesses it.
    let drawingRows: Array<Record<string, unknown>> | null = null;
    const rawPageText = lines.join("\n");
    const tagsFromText = extractEquipmentTags(rawPageText, { loose: drawingSet, knownPrefixes }).length + extractDrawingRefs(rawPageText).length;
    if (vision?.forceAllPages || pageNeedsVision(rawPageText, tagsFromText)) {
      // Don't START a vision page we can't finish — a page begun at t=50s on
      // a 60s function is pure waste, and worse, it takes the whole batch's
      // committed progress down with it.
      // A drawing set is read by THE drawing reader (overview + four zoomed
      // tiles, the person's own model) — slower, so it needs more clock.
      const firstOfBatch = p === from + 1;
      const timeForVision = visionHasTime({ now: Date.now(), deadlineMs, firstOfBatch, drawingSet });
      const priorText = stored.get(p);
      // Same bytes, same text layer: a stored page that holds far more text
      // than the layer itself can only have come from vision. A stored page
      // that merely echoes the text layer is not a transcript, and reusing
      // it would stop "read every page with vision" from ever running.
      const isTranscript = !!priorText && priorText.length >= TEXTLESS_PAGE_MAX_CHARS && priorText.length > rawPageText.length * 1.5 + 200;
      if (priorText && isTranscript) {
        // Already read for these bytes: the stored transcript stands in for
        // the model. Nothing is billed.
        lines = priorText.split("\n").map((l) => sanitizeStorageText(l.trim())).filter(Boolean);
        visionRead = true;
        reusedPages++;
      } else if (vision && visionLeft > 0 && timeForVision && drawingSet) {
        // The same reader "Read with AI" uses — one engine, one answer. Its
        // structured reading replaces pattern-matching for this page.
        try {
          const { readDrawingSheet, sheetEntityRows } = await import("@/lib/drawingCensus");
          const read = await readDrawingSheet(pdf, p, doc.name, async (a) => {
            const out = await callAiModel({
              provider: vision.provider, model: vision.model, apiKey: vision.apiKey,
              system: vision.instructions ? `${a.system}\n\n${vision.instructions}` : a.system,
              user: a.user, images: a.images, maxTokens: a.maxTokens,
              timeoutMs: deadlineMs ? Math.max(10_000, deadlineMs - Date.now() - 4_000) : undefined,
            });
            vision.onUsage(out.usage, vision.model);
            return out.text;
          });
          visionLeft--;
          if (read) {
            drawingRows = sheetEntityRows({ org_id: doc.org_id, library_id: doc.library_id, document_id: doc.id, page: p }, read.sheet)
              .map((r) => ({ ...r, nx: null, ny: null, pos_source: null }));
            const transcript = (read.sheet.transcript ?? "").split("\n").map((l) => sanitizeStorageText(l.trim())).filter(Boolean);
            if (transcript.join("\n").length > rawPageText.length) lines = transcript;
            visionRead = true;
            visionPages++;
          }
        } catch (e) {
          // Out of clock part-way through the batch: stop, and a fresh
          // invocation reads this page with its whole budget. If it already
          // HAD the whole budget, retrying would only bill the same timeout
          // again — the page keeps its text and waits in "Read all drawings
          // with AI", which gives a sheet a call of its own.
          if (isTimeoutError(e) && p > from + 1) { stoppedForTime = true; break; }
          visionLeft--;
        }
      } else if (vision && visionLeft > 0 && timeForVision) {
        try {
          const img = await renderPageAsImage(pdf, p, {
            width: 1800,                                  // small tags stay legible
            canvasImport: () => import("@napi-rs/canvas"),
          });
          const out = await transcribePageImage({
            provider: vision.provider,
            fallbackModel: vision.model,
            model: vision.readingModel,
            apiKey: vision.apiKey,
            base64: Buffer.from(img as ArrayBuffer).toString("base64"),
            mediaType: "image/png",
            documentName: doc.name,
            page: p,
            instructions: vision.instructions,
            // Whatever's left after rendering, minus room to commit.
            timeoutMs: deadlineMs ? Math.max(5_000, deadlineMs - Date.now() - 4_000) : undefined,
          });
          vision.onUsage(out.usage, out.model);
          visionLeft--;
          const transcript = out.text.trim();
          if (transcript.length >= TEXTLESS_PAGE_MAX_CHARS) {
            lines = transcript.split("\n")
              .map((l) => sanitizeStorageText(l.trim())).filter(Boolean);
            visionRead = true;
            visionPages++;
          }
        } catch (e) {
          if (isTimeoutError(e)) {
            // Ran out of clock, not out of luck. Stop BEFORE finishing this
            // page so a fresh invocation retries it with a full budget —
            // otherwise a slow page would silently downgrade to text-only.
            stoppedForTime = true;
            break;
          }
          // Provider hiccup: leave the page textless rather than fail the
          // whole document; a later pass can retry it.
          visionLeft--;
        }
      } else if (vision && !(firstOfBatch && !timeForVision)) {
        // Out of page budget, or out of clock — either way stop cleanly at
        // the last finished page so the caller's next call resumes exactly
        // here with a fresh invocation's worth of time.
        if (!timeForVision) stoppedForTime = true; else visionBudgetSpent = true;
        break;
      }
      // (First page with not even FIRST_PAGE_RESERVE_MS left: a fresh call
      // would be no better off, so the page is kept from its text layer and
      // the batch moves on. A stop here would never make progress.)
    }

    // ── Drawing intelligence: on sparse (drawing-like) pages, extract
    //    equipment tags and drawing-number references WITH the position of
    //    the text item that carried them — the structured layer behind the
    //    equipment census, register export, and reference audit.
    //    Vision-read pages have no positions (the transcript is text), so
    //    they extract from the lines themselves.
    const pageText = lines.join("\n");
    if (drawingRows) {
      entityRows.push(...drawingRows);
      for (const line of lines) {
        for (const ref of extractDrawingRefs(line)) {
          entityRows.push({
            org_id: doc.org_id, library_id: doc.library_id, document_id: doc.id,
            page: p, kind: "ref", tag: ref, raw: truncateSafe(line, 160), x: null, y: null,
            nx: null, ny: null, pos_source: null,
          });
        }
      }
    } else if (visionRead) {
      for (const line of lines) {
        for (const hit of extractEquipmentTags(line)) {
          entityRows.push({
            org_id: doc.org_id, library_id: doc.library_id, document_id: doc.id,
            page: p, kind: tagKindOf(hit, line), tag: hit.tag, raw: truncateSafe(line, 160), x: null, y: null,
            nx: null, ny: null, pos_source: null,
          });
        }
        for (const ref of extractDrawingRefs(line)) {
          entityRows.push({
            org_id: doc.org_id, library_id: doc.library_id, document_id: doc.id,
            page: p, kind: "ref", tag: ref, raw: truncateSafe(line, 160), x: null, y: null,
            nx: null, ny: null, pos_source: null,
          });
        }
      }
    } else if (drawingSet || isDrawingLikePage(pageText) || tagsFromText >= 8) {
      const loose = drawingSet;
      const onPage = new Set<string>();
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
        for (const hit of extractEquipmentTags(str, { loose, knownPrefixes })) {
          onPage.add(hit.tag);
          entityRows.push({
            org_id: doc.org_id, library_id: doc.library_id, document_id: doc.id,
            page: p, kind: tagKindOf(hit, str), tag: hit.tag, raw: truncateSafe(str, 160), x, y,
            nx, ny, pos_source: nx === null ? null : "text",
          });
        }
        for (const ref of extractDrawingRefs(str)) {
          entityRows.push({
            org_id: doc.org_id, library_id: doc.library_id, document_id: doc.id,
            page: p, kind: "ref", tag: ref, raw: truncateSafe(str, 160), x, y,
            nx, ny, pos_source: nx === null ? null : "text",
          });
        }
      }
    }

    // A tag the PDF split across two text objects ("P-" then "101A") is
    // whole again on the rebuilt line. Anything the lines carry that no
    // single object did is kept, without a position.
    if (!visionRead && (drawingSet || isDrawingLikePage(pageText) || tagsFromText >= 8)) {
      const found = new Set(entityRows.filter((r) => r.document_id === doc.id && r.page === p && (r.kind === "equipment" || r.kind === "instrument" || r.kind === "xref")).map((r) => String(r.tag)));
      for (const line of lines) {
        for (const hit of extractEquipmentTags(line, { loose: drawingSet, knownPrefixes })) {
          if (found.has(hit.tag)) continue;
          found.add(hit.tag);
          entityRows.push({
            org_id: doc.org_id, library_id: doc.library_id, document_id: doc.id,
            page: p, kind: tagKindOf(hit, line), tag: hit.tag, raw: truncateSafe(line, 160), x: null, y: null,
            nx: null, ny: null, pos_source: null,
          });
        }
      }
    }

    // ── Sheet identity from the TITLE BLOCK ────────────────────────────
    // The border says who this sheet is — drawing number, sheet, rev. That
    // declaration (kind 'self') is what the reference audit trusts;
    // filenames are only a fallback for sheets that never declared.
    if (visionRead || drawingSet || isDrawingLikePage(pageText) || tagsFromText >= 8) {
      // Off-page connector BOX NUMBERS — the small numbered box at the page
      // edge that pairs with the same number on the continuation sheet. The
      // raw line keeps the stream/destination + drawing ref for pairing.
      for (const line of lines) {
        for (const box of parseOpcBoxes(line)) {
          entityRows.push({
            org_id: doc.org_id, library_id: doc.library_id, document_id: doc.id,
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
        const self = (tag: string) => entityRows.push({
          org_id: doc.org_id, library_id: doc.library_id, document_id: doc.id,
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
      entityRows.push({
        org_id: doc.org_id, library_id: doc.library_id, document_id: doc.id,
        page: p, kind: "anchor", tag: `${kindWord} ${cap[2].toUpperCase()}`,
        raw: truncateSafe(line.trim(), 160), x: null, y: null,
        nx: null, ny: null, pos_source: null,
      });
    }

    lastCompletedPage = p;
    const { segments, lastSection } = splitPageIntoSections(lines, section);
    section = lastSection;
    let seq = 0;
    let pageHadText = false;
    for (const seg of segments) {
      for (const c of chunkPageText(seg.text)) {
        pageHadText = true;
        rows.push({
          org_id: doc.org_id, library_id: doc.library_id, document_id: doc.id,
          page: p, seq: seq++, content: c, section: seg.section,
        });
      }
    }
    if (!pageHadText) emptyPages++;
  }

  // Everything below advances only as far as the last FULLY processed page
  // (a vision-budget stop can end the batch early).
  const reached = lastCompletedPage;

  if (rows.length > 0) {
    // Idempotent batch: a retry after a mid-write failure clears the page
    // range before rewriting it, so re-running a batch can never duplicate
    // chunks (belt) — and the unique (document, page, seq) index is the
    // suspenders.
    await supabaseAdmin.from("knowledge_chunks")
      .delete().eq("document_id", doc.id).gte("page", from + 1).lte("page", reached)
      .then(() => undefined, () => undefined);
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
      const batch = rawBatch.map((r) => ({
        ...r,
        content: sanitizeStorageText(String(r.content ?? "")),
        section: r.section == null ? r.section : sanitizeStorageText(String(r.section)),
      }));
      let { error: insErr } = await supabaseAdmin.from("knowledge_chunks").insert(batch);
      if (insErr && (insErr.code === "PGRST204" || /section/.test(insErr.message))) {
        // Pre-20260914 DB: retry without the section column.
        ({ error: insErr } = await supabaseAdmin.from("knowledge_chunks")
          .insert(batch.map(({ section: _s, ...rest }) => rest)));
      }
      if (insErr && /statement timeout/i.test(insErr.message) && batch.length > 1) {
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
      if (insErr && /invalid input syntax for type json|unsupported unicode|invalid byte sequence|empty or invalid json/i.test(insErr.message)) {
        insErr = null;
        for (const row of batch) {
          const { error: rowErr } = await supabaseAdmin.from("knowledge_chunks").insert(row);
          if (rowErr && !/duplicate/i.test(rowErr.message)) insErr = rowErr;
        }
      }
      if (insErr) throw new Error(`chunk insert failed: ${insErr.message}`);
    };
    for (let i = 0; i < rows.length; i += 30) {
      await insertChunks(rows.slice(i, i + 30));
    }
  }

  // Drawing entities: same idempotent shape as chunks (clear the page range,
  // rewrite). Best-effort — a pre-20260921 DB (no table) skips silently and
  // ingestion still succeeds.
  // Pages read by the drawing census (the person's model, structured) keep
  // their equipment, instruments and off-sheet tags: this text pass never
  // overwrites them. A new revision clears the census at sync.
  const CENSUS_KINDS = ["equipment", "instrument", "xref", "census"];
  const censusPages = new Set<number>();
  {
    const { data: cp } = await supabaseAdmin.from("knowledge_page_entities").select("page").eq("document_id", doc.id).eq("kind", "census").gte("page", from + 1).lte("page", reached);
    for (const r of (cp as Array<{ page: number }> | null) ?? []) censusPages.add(r.page);
  }
  if (censusPages.size) {
    for (let i = entityRows.length - 1; i >= 0; i--) {
      const r = entityRows[i];
      if (censusPages.has(Number(r.page)) && CENSUS_KINDS.includes(String(r.kind))) entityRows.splice(i, 1);
    }
  }
  if (entityRows.length > 0 || censusPages.size) {
    if (censusPages.size) {
      await supabaseAdmin.from("knowledge_page_entities")
        .delete().eq("document_id", doc.id).gte("page", from + 1).lte("page", reached).not("kind", "in", `(${CENSUS_KINDS.join(",")})`)
        .then(() => undefined, () => undefined);
      const plain = [...Array(reached - from).keys()].map((i) => from + 1 + i).filter((pg) => !censusPages.has(pg));
      if (plain.length) await supabaseAdmin.from("knowledge_page_entities").delete().eq("document_id", doc.id).in("page", plain).in("kind", CENSUS_KINDS).then(() => undefined, () => undefined);
    } else {
      await supabaseAdmin.from("knowledge_page_entities")
        .delete().eq("document_id", doc.id).gte("page", from + 1).lte("page", reached)
        .then(() => undefined, () => undefined);
    }
    // Layered fallbacks: one schema mismatch must never cost the whole tag
    // layer. (It did once — the original CHECK (kind IN ('equipment','ref'))
    // rejected 'self'/'opc' rows, each bad row failed its batch of 500, and
    // a rebuild wiped the index and wrote NOTHING back.)
    const CORE_KINDS = new Set(["equipment", "ref"]);
    for (let i = 0; i < entityRows.length; i += 500) {
      let rows = entityRows.slice(i, i + 500);
      let { error } = await supabaseAdmin.from("knowledge_page_entities").insert(rows);
      if (error && /nx|ny|pos_source|column/i.test(error.message)) {
        // Position columns arrive with migration 20260924 — a DB that
        // hasn't run it yet must still get its TAGS.
        rows = rows.map(({ nx: _nx, ny: _ny, pos_source: _ps, ...rest }) => rest);
        ({ error } = await supabaseAdmin.from("knowledge_page_entities").insert(rows));
      }
      if (error && /check|kind/i.test(error.message)) {
        // Pre-20260925 CHECK constraint: only equipment/ref pass. Keep the
        // core layer; self/opc simply wait for the migration.
        rows = rows.filter((r) => CORE_KINDS.has(String(r.kind)));
        if (rows.length > 0) {
          ({ error } = await supabaseAdmin.from("knowledge_page_entities").insert(rows));
        } else {
          error = null;
        }
      }
      if (error) break; // missing table — drawing features just stay empty
    }
  }

  const done = reached >= pageCount;
  const docUpdate: Record<string, unknown> = {
    page_count: pageCount,
    pages_indexed: reached,
    status: done ? "ready" : "indexing",
    error: null,
    last_section: section,
  };
  let { error: updErr } = await supabaseAdmin.from("knowledge_documents")
    .update(docUpdate).eq("id", doc.id);
  if (updErr && (updErr.code === "PGRST204" || /last_section/.test(updErr.message))) {
    delete docUpdate.last_section;
    ({ error: updErr } = await supabaseAdmin.from("knowledge_documents")
      .update(docUpdate).eq("id", doc.id));
  }
  if (updErr) throw new Error(updErr.message);

  if (done) {
    // The drawing→equipment bridge: freshly extracted tags flow toward the
    // source document's equipment column + the registry. Fire-and-forget and
    // dynamically imported — bridge failures can NEVER break indexing, and
    // this fires on both the interactive and cron ingest paths.
    void import("@/lib/equipmentBridgeServer")
      .then((m) => m.computeForKnowledgeDoc(supabaseAdmin, doc.id))
      .catch(() => undefined);
    // One Estate: the tags just read off its pages become provable
    // tagged_to edges on the controlled document. Same posture — can never
    // break indexing.
    void (async () => {
      const { data } = await supabaseAdmin.from("knowledge_documents").select("source_document_id").eq("id", doc.id).maybeSingle();
      const src = (data as { source_document_id?: string | null } | null)?.source_document_id;
      if (!src) return;
      const m = await import("@/lib/estate/resolverServer");
      await m.resolveEstate(supabaseAdmin, { orgId: doc.org_id, documentIds: [src] });
    })().catch(() => undefined);
  }

  if (visionPages > 0) {
    // Running total for the UI ("14 pages read by AI vision"). Best-effort:
    // a pre-migration DB (no column) simply doesn't show the count.
    const { data: cur } = await supabaseAdmin
      .from("knowledge_documents").select("vision_pages").eq("id", doc.id).maybeSingle();
    await supabaseAdmin.from("knowledge_documents")
      .update({ vision_pages: Number(cur?.vision_pages ?? 0) + visionPages })
      .eq("id", doc.id)
      .then(() => undefined, () => undefined);
  }

  return {
    done, pageCount, pagesIndexed: reached, emptyPages, visionPages, reusedPages,
    visionBudgetSpent, stoppedForTime,
  };
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
): Promise<{ ctx?: VisionContext; forceAllPages: boolean; hold: boolean; sponsor?: string; autoRead?: boolean; autoLeft?: number }> {
  const { data: libRow } = await supabaseAdmin
    .from("knowledge_libraries").select("ai_features")
    .eq("id", doc.library_id).maybeSingle();
  const features = (libRow?.ai_features ?? {}) as Record<string, unknown>;
  // "Read new drawings automatically": every page of a new sheet goes through
  // the drawing reader on the sponsor's model, up to the monthly page cap.
  // Past the cap the sheet is indexed from its text layer and waits in
  // "Read all drawings with AI".
  const auto = readAutoRead(features);
  const autoRead = features.drawingIntel === true && auto.on;
  const autoLeft = autoRead ? pagesLeft(auto) : Infinity;
  // Only "read every page with vision" holds a sheet back when no key can
  // read it; past the auto-read cap it is indexed from its text.
  const hold = features.visionAllPages === true;
  if (autoRead && autoLeft <= 0) return { forceAllPages: false, hold: false };
  const forceAllPages = features.visionAllPages === true || autoRead;

  const sponsor = autoRead ? auto.sponsor : (doc.created_by ?? null);
  if (!sponsor) return { forceAllPages, hold };
  const { data: conn } = await supabaseAdmin
    .from("ai_connections").select("provider, model, api_key")
    .eq("org_id", doc.org_id).eq("user_id", sponsor).maybeSingle();
  if (!conn || !ALLOWED_PROVIDERS.includes(conn.provider as AiProviderId)) {
    return { forceAllPages, hold };
  }
  {
    const { data: agree, error: agreeError } = await supabaseAdmin
      .from("ai_key_agreements").select("id")
      .eq("org_id", doc.org_id).eq("user_id", sponsor)
      .eq("scope", "use").eq("agreement_version", AGREEMENT_VERSION).limit(1);
    const tableMissing = !!agreeError && (agreeError.code === "42P01" || /does not exist/i.test(agreeError.message));
    if (!tableMissing && (agree ?? []).length === 0) return { forceAllPages, hold };
  }
  const [spent, cap] = await Promise.all([
    getMonthUsage(doc.org_id, sponsor),
    getCapUsd(doc.org_id, sponsor),
  ]);
  if (cap > 0 && spent.spentUsd >= cap) return { forceAllPages, hold };

  return {
    forceAllPages, hold, sponsor, autoRead, autoLeft,
    ctx: {
      provider: conn.provider as AiProviderId,
      model: conn.model as string,
      readingModel: await jobModel(doc.org_id, sponsor, { provider: conn.provider as string, model: conn.model as string }, "reading"),
      apiKey: openAiKey(conn.api_key as string),
      budgetPages: Math.min(4, autoLeft),   // per batch — same as interactive
      forceAllPages,
      instructions: await loadOrgInstructionsBlock(supabaseAdmin, doc.org_id, "equipment"),
      onUsage,
    },
  };
}

export async function drainKnowledgeIngestQueue(opts: {
  maxPages: number;
  deadlineMs: number;
  /** Only these read libraries (an upload's own, read straight away). */
  libraryIds?: string[];
}): Promise<{ docsTouched: number; pagesIndexed: number; completed: number; errors: string[] }> {
  const out = { docsTouched: 0, pagesIndexed: 0, completed: 0, errors: [] as string[] };
  let q = supabaseAdmin
    .from("knowledge_documents")
    .select("id, org_id, library_id, name, file_key, status, pages_indexed, page_count, last_section, created_by")
    .in("status", ["pending", "stale", "indexing"]);
  if (opts.libraryIds?.length) q = q.in("library_id", opts.libraryIds);
  const { data: queued, error } = await q
    .order("created_at", { ascending: true })
    .limit(20);
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
    if (!sponsor.ctx && sponsor.hold) continue;

    out.docsTouched++;
    let pagesRead = 0;
    try {
      // Batch until this doc finishes or budget/deadline runs out.
      let row: KnowledgeDocRow = doc;
      for (;;) {
        // Same deadline the drain itself respects: a batch that overruns the
        // cron's window would be killed mid-flight and lose its pages.
        // Auto-read never passes its monthly cap, even mid-document.
        const left = sponsor.autoRead ? (sponsor.autoLeft ?? 0) - pagesRead : Infinity;
        const ctx = sponsor.ctx && left < Infinity ? (left > 0 ? { ...sponsor.ctx, budgetPages: Math.min(sponsor.ctx.budgetPages, left) } : undefined) : sponsor.ctx;
        const res = await ingestKnowledgeDocBatch(row, ctx, opts.deadlineMs);
        const processed = res.pagesIndexed - (row.pages_indexed ?? 0);
        pagesRead += res.visionPages;
        budget -= processed;
        out.pagesIndexed += processed;
        if (res.done) { out.completed++; break; }
        // No pages moved = out of time (or stuck). Either way, hand the rest
        // to the next run rather than spinning on the same page range.
        if (processed <= 0 || budget <= 0 || Date.now() > opts.deadlineMs) break;
        row = { ...row, pages_indexed: res.pagesIndexed, page_count: res.pageCount, status: "indexing" };
      }
    } catch (e) {
      const message = (e as Error).message;
      out.errors.push(`${doc.name}: ${message}`);
      await supabaseAdmin.from("knowledge_documents")
        .update({ status: "error", error: message.slice(0, 500) })
        .eq("id", doc.id)
        .then(() => undefined, () => undefined);
    }
    if (sponsor.autoRead && pagesRead > 0) {
      // Count against the monthly cap. Read fresh: another doc in this
      // drain may have counted since.
      const { data: lib } = await supabaseAdmin.from("knowledge_libraries").select("ai_features").eq("id", doc.library_id).maybeSingle();
      await supabaseAdmin.from("knowledge_libraries").update({ ai_features: withPagesUsed(lib?.ai_features as Record<string, unknown> | null, pagesRead) }).eq("id", doc.library_id)
        .then(() => undefined, () => undefined);
    }
    if (visionUsage.inputTokens + visionUsage.outputTokens > 0 && sponsor.ctx && sponsor.sponsor) {
      await recordAskUsage({
        orgId: doc.org_id, userId: sponsor.sponsor,
        provider: sponsor.ctx.provider, model: visionModel || sponsor.ctx.model,
        usage: visionUsage, ok: true, op: "knowledgeVision",
      }).catch(() => undefined);
    }
  }
  return out;
}
