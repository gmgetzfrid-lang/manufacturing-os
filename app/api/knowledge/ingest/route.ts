// /api/knowledge/ingest — turn an uploaded PDF into searchable chunks.
//
// A 900-page standard cannot be indexed inside one serverless invocation, so
// the CLIENT drives batches: POST { documentId } repeatedly; each call
// downloads the PDF from R2, extracts the next PAGE_BATCH pages of text,
// writes knowledge_chunks, bumps pages_indexed, and reports progress. The
// loop is resumable — a dropped connection or timeout just re-POSTs and
// picks up at pages_indexed.
//
// Scanned (image-only) pages yield no text; we count them so the UI can say
// "34 of 900 pages had no extractable text" instead of pretending.

import { NextRequest, NextResponse } from "next/server";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { r2, R2_BUCKET } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { chunkPageText, splitPageIntoSections } from "@/lib/knowledgeText";

export const runtime = "nodejs";
export const maxDuration = 300;

const PAGE_BATCH = 50;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Unauthorized", 401);
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authError || !user) return bad("Unauthorized", 401);

  let body: { documentId?: string };
  try { body = await req.json(); } catch { return bad("Expected JSON body"); }
  const documentId = String(body.documentId ?? "").trim();
  if (!documentId) return bad("documentId is required");

  const { data: doc } = await supabaseAdmin
    .from("knowledge_documents").select("*").eq("id", documentId).maybeSingle();
  if (!doc) return bad("Document not found", 404);

  // Ingest is a controller action (same bar as adding library documents).
  const { data: member } = await supabaseAdmin
    .from("org_members").select("role, roles")
    .eq("org_id", doc.org_id as string).eq("uid", user.id).eq("status", "active")
    .maybeSingle();
  const roles = new Set<string>([
    (member?.role as string) ?? "", ...(((member?.roles as string[]) ?? [])),
  ]);
  if (!member || (!roles.has("Admin") && !roles.has("DocCtrl"))) {
    return bad("Only Admin or Doc Control can index documents.", 403);
  }

  if (doc.status === "ready") {
    return NextResponse.json({ done: true, pageCount: doc.page_count, pagesIndexed: doc.pages_indexed });
  }

  try {
    // Pull the PDF from R2 (each batch re-downloads; simple and stateless).
    const obj = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: doc.file_key as string }));
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
    let section: string | null = (doc.last_section as string | null) ?? null;

    for (let p = from + 1; p <= to; p++) {                 // pdf.js pages are 1-based
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      // Rebuild LINES (not one long string): heading detection needs them.
      const lines: string[] = [];
      let buf = "";
      for (const item of content.items as Array<{ str?: string; hasEOL?: boolean }>) {
        buf += item.str ?? "";
        if (item.hasEOL) { lines.push(buf.trim()); buf = ""; }
        else buf += " ";
      }
      if (buf.trim()) lines.push(buf.trim());

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
      let { error: insErr } = await supabaseAdmin.from("knowledge_chunks").insert(rows);
      if (insErr && (insErr.code === "PGRST204" || /section/.test(insErr.message))) {
        // Pre-20260914 DB: retry without the section column.
        ({ error: insErr } = await supabaseAdmin.from("knowledge_chunks")
          .insert(rows.map(({ section: _s, ...rest }) => rest)));
      }
      if (insErr) throw new Error(`chunk insert failed: ${insErr.message}`);
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
      .update(docUpdate).eq("id", doc.id as string);
    if (updErr && (updErr.code === "PGRST204" || /last_section/.test(updErr.message))) {
      delete docUpdate.last_section;
      ({ error: updErr } = await supabaseAdmin.from("knowledge_documents")
        .update(docUpdate).eq("id", doc.id as string));
    }
    if (updErr) throw new Error(updErr.message);

    if (done) {
      await supabaseAdmin.from("audit_logs").insert({
        action: "KNOWLEDGE_DOC_INDEXED",
        resource_type: "knowledge_document", resource_id: String(doc.id),
        org_id: doc.org_id, user_id: user.id,
        details: { name: doc.name, pages: pageCount },
      }).then(() => undefined, () => undefined);
    }

    return NextResponse.json({ done, pageCount, pagesIndexed: to, emptyPages });
  } catch (e) {
    const message = (e as Error).message;
    await supabaseAdmin.from("knowledge_documents")
      .update({ status: "error", error: message.slice(0, 500) })
      .eq("id", doc.id as string);
    return bad(`Indexing failed: ${message}`, 502);
  }
}
