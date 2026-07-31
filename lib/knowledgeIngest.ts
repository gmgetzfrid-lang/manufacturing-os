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
import { isDrawingLikePage, extractEquipmentTags, extractDrawingRefs } from "@/lib/drawingText";

export const PAGE_BATCH = 50;

export interface IngestBatchResult {
  done: boolean;
  pageCount: number;
  pagesIndexed: number;
  emptyPages: number;
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
};

/** Ingest the next PAGE_BATCH pages of one knowledge document. Throws on
 *  failure — callers decide whether to mark the row errored (the API route
 *  does; the cron records and moves on). */
export async function ingestKnowledgeDocBatch(doc: KnowledgeDocRow): Promise<IngestBatchResult> {
  ensurePdfPolyfills();

  // Pull the PDF from R2 (each batch re-downloads; simple and stateless).
  const obj = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: doc.file_key }));
  const bytes = new Uint8Array(await new Response(obj.Body as ReadableStream).arrayBuffer());

  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes);
  const pageCount = pdf.numPages;

  const from = Number(doc.pages_indexed ?? 0);           // 0-based next page
  const to = Math.min(from + PAGE_BATCH, pageCount);
  let emptyPages = 0;
  const rows: Array<Record<string, unknown>> = [];
  // Section heading in force where the last batch left off — sections span
  // pages, so it persists on the document row between batches.
  let section: string | null = doc.last_section ?? null;

  const entityRows: Array<Record<string, unknown>> = [];
  for (let p = from + 1; p <= to; p++) {                 // pdf.js pages are 1-based
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    // Rebuild LINES (not one long string): heading detection needs them.
    const lines: string[] = [];
    let buf = "";
    type TextItem = { str?: string; hasEOL?: boolean; transform?: number[] };
    for (const item of content.items as TextItem[]) {
      buf += item.str ?? "";
      if (item.hasEOL) { lines.push(buf.trim()); buf = ""; }
      else buf += " ";
    }
    if (buf.trim()) lines.push(buf.trim());

    // ── Drawing intelligence: on sparse (drawing-like) pages, extract
    //    equipment tags and drawing-number references WITH the position of
    //    the text item that carried them — the structured layer behind the
    //    equipment census, register export, and reference audit.
    const pageText = lines.join("\n");
    if (isDrawingLikePage(pageText)) {
      for (const item of content.items as TextItem[]) {
        const str = (item.str ?? "").trim();
        if (str.length < 2) continue;
        const x = item.transform?.[4] ?? null;
        const y = item.transform?.[5] ?? null;
        for (const hit of extractEquipmentTags(str)) {
          entityRows.push({
            org_id: doc.org_id, library_id: doc.library_id, document_id: doc.id,
            page: p, kind: "equipment", tag: hit.tag, raw: str.slice(0, 160), x, y,
          });
        }
        for (const ref of extractDrawingRefs(str)) {
          entityRows.push({
            org_id: doc.org_id, library_id: doc.library_id, document_id: doc.id,
            page: p, kind: "ref", tag: ref, raw: str.slice(0, 160), x, y,
          });
        }
      }
    }

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

  if (rows.length > 0) {
    // Idempotent batch: a retry after a mid-write failure clears the page
    // range before rewriting it, so re-running a batch can never duplicate
    // chunks (belt) — and the unique (document, page, seq) index is the
    // suspenders.
    await supabaseAdmin.from("knowledge_chunks")
      .delete().eq("document_id", doc.id).gte("page", from + 1).lte("page", to)
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
      .delete().eq("document_id", doc.id).gte("page", from + 1).lte("page", to)
      .then(() => undefined, () => undefined);
    for (let i = 0; i < entityRows.length; i += 500) {
      const { error } = await supabaseAdmin
        .from("knowledge_page_entities").insert(entityRows.slice(i, i + 500));
      if (error) break; // missing table/columns — drawing features just stay empty
    }
  }

  const done = to >= pageCount;
  const docUpdate: Record<string, unknown> = {
    page_count: pageCount,
    pages_indexed: to,
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

  return { done, pageCount, pagesIndexed: to, emptyPages };
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
        const res = await ingestKnowledgeDocBatch(row);
        const processed = res.pagesIndexed - (row.pages_indexed ?? 0);
        budget -= processed;
        out.pagesIndexed += processed;
        if (res.done) { out.completed++; break; }
        if (budget <= 0 || Date.now() > opts.deadlineMs) break;
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
