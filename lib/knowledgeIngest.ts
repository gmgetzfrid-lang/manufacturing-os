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

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { r2, R2_BUCKET } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { chunkPageText, splitPageIntoSections, ensurePdfPolyfills } from "@/lib/knowledgeText";
import {
  isDrawingLikePage, extractEquipmentTags, extractDrawingRefs, extractTitleBlock,
  parseOpcBoxes, pageNeedsVision, TEXTLESS_PAGE_MAX_CHARS,
} from "@/lib/drawingText";
import { transcribePageImage } from "@/lib/knowledgeVision";
import { isTimeoutError, type AiProviderId } from "@/lib/ai/providerCall";

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
  onUsage: (usage: { inputTokens: number; outputTokens: number }, model: string) => void;
}

export interface IngestBatchResult {
  done: boolean;
  pageCount: number;
  pagesIndexed: number;
  emptyPages: number;
  /** Pages read by AI vision in this batch (no text layer). */
  visionPages: number;
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

    // ── VISION FALLBACK: this page can't be read from its text layer.
    //    AutoCAD SHX text plots as LINE-WORK (tags exist as strokes, not
    //    text objects) and scans have no text at all. A drawing can even
    //    look "readable" — a TrueType title block yields a few hundred
    //    characters while every tag stays invisible — so the decision uses
    //    tags-found, not just length (see pageNeedsVision). The transcript
    //    then flows through the SAME pipeline (sections → chunks → tags →
    //    refs), making the sheet fully searchable and citable.
    let visionRead = false;
    const rawPageText = lines.join("\n");
    const tagsFromText = extractEquipmentTags(rawPageText).length + extractDrawingRefs(rawPageText).length;
    if (vision?.forceAllPages || pageNeedsVision(rawPageText, tagsFromText)) {
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
            documentName: doc.name,
            page: p,
            // Whatever's left after rendering, minus room to commit.
            timeoutMs: deadlineMs ? Math.max(5_000, deadlineMs - Date.now() - 4_000) : undefined,
          });
          vision.onUsage(out.usage, out.model);
          visionLeft--;
          const transcript = out.text.trim();
          if (transcript.length >= TEXTLESS_PAGE_MAX_CHARS) {
            lines = transcript.split("\n").map((l) => l.trim()).filter(Boolean);
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
      } else if (vision) {
        // Out of page budget, or out of clock — either way stop cleanly at
        // the last finished page so the caller's next call resumes exactly
        // here with a fresh invocation's worth of time.
        if (!timeForVision) stoppedForTime = true; else visionBudgetSpent = true;
        break;
      }
    }

    // ── Drawing intelligence: on sparse (drawing-like) pages, extract
    //    equipment tags and drawing-number references WITH the position of
    //    the text item that carried them — the structured layer behind the
    //    equipment census, register export, and reference audit.
    //    Vision-read pages have no positions (the transcript is text), so
    //    they extract from the lines themselves.
    const pageText = lines.join("\n");
    if (visionRead) {
      for (const line of lines) {
        for (const hit of extractEquipmentTags(line)) {
          entityRows.push({
            org_id: doc.org_id, library_id: doc.library_id, document_id: doc.id,
            page: p, kind: "equipment", tag: hit.tag, raw: line.slice(0, 160), x: null, y: null,
            nx: null, ny: null, pos_source: null,
          });
        }
        for (const ref of extractDrawingRefs(line)) {
          entityRows.push({
            org_id: doc.org_id, library_id: doc.library_id, document_id: doc.id,
            page: p, kind: "ref", tag: ref, raw: line.slice(0, 160), x: null, y: null,
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
          entityRows.push({
            org_id: doc.org_id, library_id: doc.library_id, document_id: doc.id,
            page: p, kind: "equipment", tag: hit.tag, raw: str.slice(0, 160), x, y,
            nx, ny, pos_source: nx === null ? null : "text",
          });
        }
        for (const ref of extractDrawingRefs(str)) {
          entityRows.push({
            org_id: doc.org_id, library_id: doc.library_id, document_id: doc.id,
            page: p, kind: "ref", tag: ref, raw: str.slice(0, 160), x, y,
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
          entityRows.push({
            org_id: doc.org_id, library_id: doc.library_id, document_id: doc.id,
            page: p, kind: "opc", tag: box, raw: line.slice(0, 160), x: null, y: null,
            nx: null, ny: null, pos_source: null,
          });
        }
      }
      const tb = extractTitleBlock(pageText);
      if (tb.drawingNumber) {
        const raw = (`DWG ${tb.drawingNumber}` +
          (tb.sheetNumber ? ` SH ${tb.sheetNumber}` : "") +
          (tb.rev ? ` REV ${tb.rev}` : "")).slice(0, 160);
        const self = (tag: string) => entityRows.push({
          org_id: doc.org_id, library_id: doc.library_id, document_id: doc.id,
          page: p, kind: "self", tag, raw, x: null, y: null,
          nx: null, ny: null, pos_source: null,
        });
        self(tb.drawingNumber);
        if (tb.sheetNumber) self(`${tb.drawingNumber}-SH${tb.sheetNumber}`);
      }
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
    let { error: insErr } = await supabaseAdmin.from("knowledge_chunks").insert(rows);
    if (insErr && (insErr.code === "PGRST204" || /section/.test(insErr.message))) {
      // Pre-20260914 DB: retry without the section column.
      ({ error: insErr } = await supabaseAdmin.from("knowledge_chunks")
        .insert(rows.map(({ section: _s, ...rest }) => rest)));
    }
    if (insErr) throw new Error(`chunk insert failed: ${insErr.message}`);
  }

  // Drawing entities: same idempotent shape as chunks (clear the page range,
  // rewrite). Best-effort — a pre-20260921 DB (no table) skips silently and
  // ingestion still succeeds.
  if (entityRows.length > 0) {
    await supabaseAdmin.from("knowledge_page_entities")
      .delete().eq("document_id", doc.id).gte("page", from + 1).lte("page", reached)
      .then(() => undefined, () => undefined);
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
    done, pageCount, pagesIndexed: reached, emptyPages, visionPages,
    visionBudgetSpent, stoppedForTime,
  };
}

/** Background drain used by the maintenance cron: keep ingesting queued
 *  (pending/stale) documents until the page budget or deadline runs out.
 *  Errors mark the row and continue — one broken PDF must not starve the
 *  queue. */
export async function drainKnowledgeIngestQueue(opts: {
  maxPages: number;
  deadlineMs: number;
}): Promise<{ docsTouched: number; pagesIndexed: number; completed: number; errors: string[] }> {
  const out = { docsTouched: 0, pagesIndexed: 0, completed: 0, errors: [] as string[] };
  const { data: queued, error } = await supabaseAdmin
    .from("knowledge_documents")
    .select("id, org_id, library_id, name, file_key, status, pages_indexed, page_count, last_section")
    .in("status", ["pending", "stale", "indexing"])
    .order("created_at", { ascending: true })
    .limit(20);
  if (error || !queued) return out;

  let budget = opts.maxPages;
  for (const doc of queued as KnowledgeDocRow[]) {
    if (budget <= 0 || Date.now() > opts.deadlineMs) break;
    out.docsTouched++;
    try {
      // Batch until this doc finishes or budget/deadline runs out.
      let row: KnowledgeDocRow = doc;
      for (;;) {
        // Same deadline the drain itself respects: a batch that overruns the
        // cron's window would be killed mid-flight and lose its pages.
        const res = await ingestKnowledgeDocBatch(row, undefined, opts.deadlineMs);
        const processed = res.pagesIndexed - (row.pages_indexed ?? 0);
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
  }
  return out;
}
