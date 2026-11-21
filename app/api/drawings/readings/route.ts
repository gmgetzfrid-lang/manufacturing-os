// GET /api/drawings/readings - what the drawing reader found on the sheets,
// for screens in the browser. knowledge_page_entities is server-only, so it
// is read here, and only for drawings the caller can open (the same access
// rules as Ask). Reads only.
//
//   ?orgId                 the off-page references ("TO 2002-D 2001 SH 3")
//                          and the tags on every page: the connector checks
//   ?orgId&id=5510.19      every place a sheet prints that equipment ID,
//                          with the tag and name beside it

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadPrincipal, readableControlledDocIds } from "@/lib/knowledgeAccess";
import { fetchAllRows } from "@/lib/fetchAllRows";
import type { SheetReading } from "@/lib/drawingReadings";

export const runtime = "nodejs";
export const maxDuration = 60;

const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });
type Row = { document_id: string; page: number; kind: string; tag: string; raw: string | null };

export async function GET(req: NextRequest) {
  const orgId = req.nextUrl.searchParams.get("orgId") ?? "";
  const id = (req.nextUrl.searchParams.get("id") ?? "").trim().slice(0, 40);
  if (!/^[0-9a-f-]{36}$/i.test(orgId)) return bad("Which workspace?");
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return bad("Sign in again.", 401);
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(auth.slice(7));
  if (authErr || !user) return bad("Sign in again.", 401);
  const principal = await loadPrincipal(orgId, user.id);
  if (!principal) return bad("You're not a member of this workspace.", 403);

  // The readings first (one ID's callouts), or every reading copy (connectors).
  let rows: Row[] = [];
  let mirrorIds: string[];
  if (id) {
    const { data, error } = await supabaseAdmin.from("knowledge_page_entities").select("document_id, page, kind, tag, raw")
      .eq("org_id", orgId).eq("kind", "equipment").ilike("raw", `%(${id.replace(/[%_\\]/g, "")})%`).limit(60);
    if (error) return bad(`The drawings' readings couldn't be read: ${error.message}`, 500);
    rows = (data ?? []) as Row[];
    mirrorIds = [...new Set(rows.map((r) => r.document_id))];
  } else {
    const all = await fetchAllRows<{ id: string }>((from, to) =>
      supabaseAdmin.from("knowledge_documents").select("id").eq("org_id", orgId).not("source_document_id", "is", null).order("id").range(from, to));
    if (all.error) return bad(`The drawings' readings couldn't be read: ${all.error}`, 500);
    mirrorIds = all.rows.map((m) => m.id);
  }

  // Which drawing each reading copy is of, and which of those this person can open.
  const toDoc = new Map<string, string>();
  for (let i = 0; i < mirrorIds.length; i += 200) {
    const { data, error } = await supabaseAdmin.from("knowledge_documents").select("id, source_document_id").eq("org_id", orgId).in("id", mirrorIds.slice(i, i + 200));
    if (error) return bad(`The drawings' readings couldn't be read: ${error.message}`, 500);
    for (const m of (data ?? []) as Array<{ id: string; source_document_id: string | null }>) if (m.source_document_id) toDoc.set(m.id, m.source_document_id);
  }
  let readable: Set<string>;
  try { readable = await readableControlledDocIds(principal, [...new Set(toDoc.values())]); }
  catch (e) { return bad(`Who can open which drawing couldn't be checked: ${(e as Error).message}`, 500); }
  for (const [m, d] of toDoc) if (!readable.has(d)) toDoc.delete(m);

  if (!id) {
    const ids = [...toDoc.keys()];
    for (let i = 0; i < ids.length; i += 60) {
      const ents = await fetchAllRows<Row>((from, to) =>
        supabaseAdmin.from("knowledge_page_entities").select("document_id, page, kind, tag, raw").eq("org_id", orgId).in("document_id", ids.slice(i, i + 60))
          .in("kind", ["xref", "equipment", "instrument"]).order("id").range(from, to));
      if (ents.error) return bad(`The drawings' readings couldn't be read: ${ents.error}`, 500);
      rows.push(...ents.rows);
    }
  }
  const readings: SheetReading[] = [];
  for (const r of rows) {
    const doc = toDoc.get(r.document_id);
    if (doc) readings.push({ documentId: doc, page: r.page, kind: r.kind, tag: r.tag, raw: r.raw });
  }
  return NextResponse.json({ readings });
}
