// /api/equipment/sheets — "open a vessel, see its sheets" (GM-14 / GAP-301).
//
//   GET ?orgId&tag=<tag>   → the sheets an equipment tag is on, for THIS caller:
//     relations — the document↔equipment relation (document_assets) read AS
//                 THE CALLER (their own session, so documents RLS and, once
//                 20261170 is pasted, the relation's own read policy decide
//                 what comes back — DACL-11), each with its sheet address,
//                 pages, who asserted it, the model when a page was
//                 AI-transcribed, and the revision it was read from;
//     extracted — sheets whose indexed copy carries the tag but where no
//                 relation was recorded yet (not applied, or a P&ID uploaded
//                 straight into a knowledge library). knowledge_page_entities
//                 stays REVOKEd from every client role (20260921): it is read
//                 here with the service role and filtered per caller through
//                 lib/knowledgeAccess (a copy of a controlled document only
//                 when the caller can read that document; fails closed). A
//                 copy at an earlier revision than its document never counts
//                 (GAP-309). The read is paged; `extractedCut` says when it
//                 reached its ceiling (the hub shows it).
//
// Any active member may ask (the asset hub is every member's page); what
// comes back is what they could open anyway. No AI call.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { callerScopedClient } from "@/lib/serverAuth";
import { loadPrincipal, readableControlledDocIds } from "@/lib/knowledgeAccess";
import { normalizeTag, tagKey } from "@/lib/codebook";
import { sheetAddressForPage, sheetText, readWindows, type Builder } from "@/lib/equipmentBridgeServer";

export const runtime = "nodejs";

/** The most indexed-page rows the 'extracted' read takes for one tag. A
 *  read that reaches it is said (`extractedCut`, and a note), never a
 *  silent cut (BR-11). */
const EXTRACTED_ROWS_CAP = 5000;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

type PgErr = { code?: string; message?: string } | null;
const missingColumn = (e: PgErr) => !!e && (e.code === "42703" || e.code === "PGRST204" || /column [\w."]+ does not exist/i.test(e.message ?? ""));

export interface SheetRelation {
  documentId: string; libraryId: string | null; number: string; title: string | null; rev: string | null;
  source: string; sheetLabel: string | null; pages: number[];
  assertedBy: "machine" | "human" | null; model: string | null; sourceRevision: string | null;
  vanished: boolean; superseded: boolean;
}
export interface SheetExtracted {
  knowledgeDocumentId: string; documentId: string | null; name: string; libraryId: string | null;
  pages: number[]; sheets: string[];
}

export async function GET(req: NextRequest) {
  const orgId = req.nextUrl.searchParams.get("orgId") ?? "";
  const rawTag = (req.nextUrl.searchParams.get("tag") ?? "").trim();
  if (!orgId || !rawTag) return bad("orgId and tag required");
  if (rawTag.length > 80) return bad("tag too long");
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Not authenticated", 401);
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authErr || !user) return bad("Not authenticated", 401);
  const principal = await loadPrincipal(orgId, user.id);
  if (!principal) return bad("Not a member of this workspace", 403);
  const caller = callerScopedClient(req);
  if ("error" in caller) return bad(caller.error, caller.status);

  const key = tagKey(rawTag);
  const display = normalizeTag(rawTag);
  const notes: string[] = [];

  // The asset, by the one tag grammar (archived equipment is not an answer).
  const { data: asset } = await caller.from("assets").select("id, tag, archived")
    .eq("org_id", orgId).eq("tag_normalized", key).maybeSingle();
  const assetRow = asset && !(asset as { archived?: boolean }).archived ? asset as { id: string; tag: string } : null;

  // ── relations, as the caller.
  const relations: SheetRelation[] = [];
  if (assetRow) {
    let rel: { data: unknown; error: { code?: string; message: string } | null } = await caller.from("document_assets")
      .select("document_id, source, sheet_label, pages, asserted_by, model, source_revision, vanished_at, superseded_at")
      .eq("asset_id", assetRow.id).limit(500);
    if (rel.error && missingColumn(rel.error)) {
      rel = await caller.from("document_assets").select("document_id, source, sheet_label, pages").eq("asset_id", assetRow.id).limit(500);
    }
    if (rel.error && missingColumn(rel.error)) {
      rel = await caller.from("document_assets").select("document_id, source").eq("asset_id", assetRow.id).limit(500);
    }
    if (rel.error) return bad(`The equipment's links could not be read: ${rel.error.message}`, 500);
    const linkRows = (rel.data ?? []) as Array<Record<string, unknown>>;
    const ids = [...new Set(linkRows.map((r) => String(r.document_id)))];
    const docs = new Map<string, Record<string, unknown>>();
    for (let i = 0; i < ids.length; i += 100) {
      // The caller's own documents read — what they cannot open never comes back.
      const { data } = await caller.from("documents").select("id, library_id, document_number, title, name, rev, status")
        .eq("org_id", orgId).in("id", ids.slice(i, i + 100));
      for (const d of (data ?? []) as Array<Record<string, unknown>>) if (d.status !== "Archived") docs.set(String(d.id), d);
    }
    for (const r of linkRows) {
      const d = docs.get(String(r.document_id));
      if (!d) continue;
      relations.push({
        documentId: String(d.id), libraryId: (d.library_id as string | null) ?? null,
        number: String(d.document_number || d.title || d.name || "—"), title: (d.title as string | null) ?? null,
        rev: (d.rev as string | null) ?? null, source: String(r.source ?? ""),
        sheetLabel: (r.sheet_label as string | null) ?? null,
        pages: Array.isArray(r.pages) ? (r.pages as number[]) : [],
        assertedBy: (r.asserted_by as "machine" | "human" | null) ?? (r.source === "drawing" ? "machine" : null),
        model: (r.model as string | null) ?? null, sourceRevision: (r.source_revision as string | null) ?? null,
        vanished: !!r.vanished_at, superseded: !!r.superseded_at,
      });
    }
  }

  // ── extracted, filtered per caller.
  const extracted: SheetExtracted[] = [];
  let extractedCut = false;
  {
    // Paged window by window (BR-11): a response PostgREST cut at its
    // max-rows is not the end, and a read that reaches the ceiling says so.
    const ents = await readWindows<{ document_id: string; page: number }>(() => supabaseAdmin.from("knowledge_page_entities")
      .select("id, document_id, page")
      .eq("org_id", orgId).in("kind", ["equipment"]).in("tag", [display])
      .order("id", { ascending: true }) as unknown as Builder, EXTRACTED_ROWS_CAP);
    if (ents.error) notes.push("The extracted sheets could not be read.");
    if (ents.truncated) {
      extractedCut = true;
      notes.push(`The extracted sheets stopped at ${EXTRACTED_ROWS_CAP} indexed pages — the list may be incomplete.`);
    }
    const pagesByCopy = new Map<string, Set<number>>();
    for (const e of (ents.error ? [] : ents.rows)) {
      (pagesByCopy.get(e.document_id) ?? pagesByCopy.set(e.document_id, new Set()).get(e.document_id)!).add(Number(e.page));
    }
    const copyIds = [...pagesByCopy.keys()];
    const copies: Array<{ id: string; name: string | null; source_document_id: string | null; source_version_id: string | null; status: string | null }> = [];
    for (let i = 0; i < copyIds.length; i += 100) {
      const { data } = await supabaseAdmin.from("knowledge_documents")
        .select("id, name, source_document_id, source_version_id, status")
        .eq("org_id", orgId).in("id", copyIds.slice(i, i + 100));
      copies.push(...((data ?? []) as typeof copies));
    }
    const mirrored = [...new Set(copies.map((c) => c.source_document_id).filter((x): x is string => !!x))];
    let readable = new Set<string>();
    try { readable = mirrored.length ? await readableControlledDocIds(principal, mirrored) : new Set(); }
    catch { readable = new Set(); }
    const current = new Map<string, { current_version_id: string | null; library_id: string | null; document_number: string | null; status: string | null }>();
    const readableIds = mirrored.filter((id) => readable.has(id));
    for (let i = 0; i < readableIds.length; i += 100) {
      const { data } = await supabaseAdmin.from("documents").select("id, current_version_id, library_id, document_number, status")
        .eq("org_id", orgId).in("id", readableIds.slice(i, i + 100));
      for (const d of (data ?? []) as Array<Record<string, unknown>>) {
        current.set(String(d.id), {
          current_version_id: (d.current_version_id as string | null) ?? null, library_id: (d.library_id as string | null) ?? null,
          document_number: (d.document_number as string | null) ?? null, status: (d.status as string | null) ?? null,
        });
      }
    }
    const linked = new Set(relations.map((r) => r.documentId));
    const counted = copies.filter((c) => {
      if (c.status !== "ready") return false;
      if (!c.source_document_id) return true;           // a knowledge upload (DEC-83: org-wide)
      const d = current.get(c.source_document_id);
      if (!d || d.status === "Archived") return false;   // unreadable to the caller, or gone
      if (linked.has(c.source_document_id)) return false; // already a recorded relation
      return !d.current_version_id || !c.source_version_id || d.current_version_id === c.source_version_id;
    });
    // The sheet address of each page, from the copy's own title blocks.
    for (const c of counted) {
      const pages = [...(pagesByCopy.get(c.id) ?? [])].sort((a, b) => a - b);
      const { data: selfRows } = await supabaseAdmin.from("knowledge_page_entities")
        .select("page, tag, raw").eq("document_id", c.id).in("kind", ["self"]).in("page", pages).limit(200);
      const byPage = new Map<number, Array<{ tag: string; raw: string | null }>>();
      for (const s of (selfRows ?? []) as Array<{ page: number; tag: string; raw: string | null }>) {
        (byPage.get(Number(s.page)) ?? byPage.set(Number(s.page), []).get(Number(s.page))!).push(s);
      }
      // GOV-9: a title block read off an AI transcription is a reading, not
      // an identity — marked unconfirmed. A missing column (before 20261122)
      // records nothing; any other failure fails toward the warning.
      const vis = await supabaseAdmin.from("knowledge_chunks").select("page")
        .eq("document_id", c.id).eq("source", "vision").in("page", pages).limit(1000);
      const aiAll = !!vis.error && !missingColumn(vis.error);
      const aiPages = new Set(((vis.data ?? []) as Array<{ page: number }>).map((v) => Number(v.page)));
      const d = c.source_document_id ? current.get(c.source_document_id) : undefined;
      extracted.push({
        knowledgeDocumentId: c.id, documentId: c.source_document_id,
        name: d?.document_number || c.name || "Untitled", libraryId: d?.library_id ?? null, pages,
        sheets: pages.map((p) => sheetText(sheetAddressForPage(p, byPage.get(p) ?? [], aiAll || aiPages.has(p)))),
      });
    }
  }

  return NextResponse.json({ asset: assetRow, relations, extracted, extractedCut, extractedCap: EXTRACTED_ROWS_CAP, notes });
}
