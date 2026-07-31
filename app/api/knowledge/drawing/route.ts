// /api/knowledge/drawing — the deterministic answers layer for drawing
// libraries. Counting vessels or auditing off-page references is DATA work,
// not retrieval work — this route computes from knowledge_page_entities:
//
//   GET  ?orgId&libraryId&action=census   → equipment census by category,
//                                           drawing-ref audit (resolved vs
//                                           missing), suggestions
//   GET  ?orgId&libraryId&action=export   → the equipment register as CSV
//                                           (opens straight into Excel)
//   POST { orgId, libraryId, action:"rebuild" }
//                                         → re-extract everything: docs go
//                                           stale, chunks + entities clear,
//                                           the page's auto-indexer re-runs
//                                           (needed once for docs indexed
//                                           before the entity layer existed)
//
// ACL: entities mirror controlled documents — results exclude every doc the
// CALLER can't read, same engine as the ask route. Fails closed.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadPrincipal, readableControlledDocIds } from "@/lib/knowledgeAccess";
import {
  buildEquipmentCensus, auditDrawingRefs, equipmentRegisterCsv,
} from "@/lib/drawingText";

export const runtime = "nodejs";
export const maxDuration = 60;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

async function authUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  return error || !user ? null : user;
}

type EntityRow = { document_id: string; page: number; kind: string; tag: string };
type DocRow = { id: string; name: string; source_document_id: string | null; status: string };

/** Load the library's docs + entities with the caller's ACL applied. */
async function loadVisibleEntities(orgId: string, userId: string, libraryId: string): Promise<{
  docs: DocRow[]; entities: EntityRow[]; error?: string;
} > {
  const principal = await loadPrincipal(orgId, userId);
  if (!principal) return { docs: [], entities: [], error: "Not a member of this workspace" };

  const { data: docRows, error: docErr } = await supabaseAdmin
    .from("knowledge_documents")
    .select("id, name, source_document_id, status")
    .eq("library_id", libraryId).eq("org_id", orgId);
  if (docErr) return { docs: [], entities: [], error: docErr.message };
  let docs = (docRows ?? []) as DocRow[];

  // ACL: drop mirrors of controlled docs the caller can't read (fail closed).
  const linked = docs.filter((d) => d.source_document_id);
  if (linked.length > 0) {
    try {
      const readable = await readableControlledDocIds(
        principal, [...new Set(linked.map((d) => d.source_document_id as string))],
      );
      docs = docs.filter((d) => !d.source_document_id || readable.has(d.source_document_id));
    } catch {
      docs = docs.filter((d) => !d.source_document_id);
    }
  }
  if (docs.length === 0) return { docs: [], entities: [] };

  const entities: EntityRow[] = [];
  const docIds = docs.map((d) => d.id);
  for (let i = 0; i < docIds.length; i += 50) {
    const { data, error } = await supabaseAdmin
      .from("knowledge_page_entities")
      .select("document_id, page, kind, tag")
      .in("document_id", docIds.slice(i, i + 50))
      .limit(50000);
    if (error) {
      const missing = error.code === "42P01" || /does not exist/i.test(error.message);
      return { docs, entities: [], error: missing ? "migration-missing" : error.message };
    }
    entities.push(...((data ?? []) as EntityRow[]));
  }
  return { docs, entities };
}

export async function GET(req: NextRequest) {
  const orgId = (req.nextUrl.searchParams.get("orgId") ?? "").trim();
  const libraryId = (req.nextUrl.searchParams.get("libraryId") ?? "").trim();
  const action = req.nextUrl.searchParams.get("action") ?? "census";
  if (!orgId || !libraryId) return bad("orgId and libraryId are required");
  const user = await authUser(req);
  if (!user) return bad("Unauthorized", 401);

  const { docs, entities, error } = await loadVisibleEntities(orgId, user.id, libraryId);
  if (error === "migration-missing") {
    return bad("Drawing intelligence needs migration 20260921 — run it in Supabase, then Rebuild index.", 424);
  }
  if (error) return bad(error, 500);

  const nameById = new Map(docs.map((d) => [d.id, d.name]));
  const equipment = entities.filter((e) => e.kind === "equipment");
  const refs = entities.filter((e) => e.kind === "ref");

  // ── CSV register download ──────────────────────────────────────────────
  if (action === "export") {
    const csv = equipmentRegisterCsv(equipment.map((e) => ({
      tag: e.tag, documentName: nameById.get(e.document_id) ?? "Sheet", page: e.page,
    })));
    return new NextResponse(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="equipment-register.csv"`,
      },
    });
  }

  // ── Census + reference audit + suggestions ─────────────────────────────
  const census = buildEquipmentCensus(equipment);
  const refsByDoc = new Map<string, string[]>();
  for (const r of refs) {
    const list = refsByDoc.get(r.document_id) ?? [];
    list.push(r.tag);
    refsByDoc.set(r.document_id, list);
  }
  const audit = auditDrawingRefs(docs.map((d) => ({ id: d.id, name: d.name })), refsByDoc);

  // Deterministic coach suggestions — "give me X and I can do more".
  const suggestions: string[] = [];
  const readyDocs = docs.filter((d) => d.status === "ready").length;

  // Which ready docs produced ANY text at all? Zero-text docs are scans —
  // a completely different problem than "no tags matched".
  const docsWithText = new Set<string>();
  {
    const readyIds = docs.filter((d) => d.status === "ready").map((d) => d.id);
    for (let i = 0; i < readyIds.length; i += 50) {
      const { data } = await supabaseAdmin
        .from("knowledge_chunks").select("document_id")
        .in("document_id", readyIds.slice(i, i + 50))
        .limit(20000);
      for (const r of data ?? []) docsWithText.add(r.document_id as string);
    }
  }
  const textlessCount = docs.filter((d) => d.status === "ready" && !docsWithText.has(d.id)).length;

  if (textlessCount > 0) {
    suggestions.push(
      `${textlessCount} of ${readyDocs} sheet(s) produced NO text at all — they are scanned images ` +
      "(or pure graphics). Search, tags, and cited answers cannot see inside them. Re-issuing them " +
      "as vector PDF exports from CAD fixes everything; OCR support is the alternative — ask for it.",
    );
  }
  if (readyDocs > 0 && entities.length === 0 && textlessCount < readyDocs) {
    suggestions.push(
      "The sheets have text but no tags were extracted. If they were indexed before drawing " +
      "intelligence existed, hit \"Rebuild index\" — it re-reads every page.",
    );
  }
  if (census.unknownPrefixes.length > 0) {
    suggestions.push(
      `I found tag prefixes I don't recognize: ${census.unknownPrefixes.slice(0, 8).join(", ")}. ` +
      "Tell me what they mean in Library AI setup → standing instructions (e.g. \"ZZ- means sample " +
      "station\") and answers will categorize them correctly.",
    );
  }
  if (audit.missing.length > 0) {
    suggestions.push(
      `${audit.missing.length} referenced drawing number(s) aren't in this library — link the source ` +
      "folders that contain them and cross-sheet questions will stop dead-ending.",
    );
  }

  return NextResponse.json({
    sheetCount: docs.length,
    readyCount: readyDocs,
    textlessCount,
    census,
    audit,
    suggestions,
  });
}

export async function POST(req: NextRequest) {
  let body: { orgId?: string; libraryId?: string; action?: string };
  try { body = await req.json(); } catch { return bad("Expected JSON body"); }
  const orgId = String(body.orgId ?? "").trim();
  const libraryId = String(body.libraryId ?? "").trim();
  if (!orgId || !libraryId) return bad("orgId and libraryId are required");
  const user = await authUser(req);
  if (!user) return bad("Unauthorized", 401);
  const principal = await loadPrincipal(orgId, user.id);
  if (!principal?.isController) {
    return bad("Only Admin or Doc Control can rebuild the index.", 403);
  }
  if (body.action !== "rebuild") return bad("Unknown action");

  // Reset every doc to stale + clear derived data; the page's auto-indexer
  // re-reads everything (chunks AND entities this time).
  const { data: docRows } = await supabaseAdmin
    .from("knowledge_documents").select("id")
    .eq("library_id", libraryId).eq("org_id", orgId);
  const ids = (docRows ?? []).map((d) => d.id as string);
  if (ids.length === 0) return NextResponse.json({ ok: true, docs: 0 });

  for (let i = 0; i < ids.length; i += 50) {
    const slice = ids.slice(i, i + 50);
    await supabaseAdmin.from("knowledge_chunks").delete().in("document_id", slice);
    await supabaseAdmin.from("knowledge_page_entities").delete().in("document_id", slice)
      .then(() => undefined, () => undefined);
    await supabaseAdmin.from("knowledge_documents")
      .update({ status: "stale", pages_indexed: 0, page_count: null, last_section: null, error: null })
      .in("id", slice);
  }
  return NextResponse.json({ ok: true, docs: ids.length });
}
