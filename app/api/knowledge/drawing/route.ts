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
  parseUnitMap, extractDrawingRefs,
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

type EntityRow = { document_id: string; page: number; kind: string; tag: string; raw?: string | null };
type DocRow = {
  id: string; name: string; source_document_id: string | null; status: string;
  page_count?: number | null; pages_indexed?: number | null; vision_pages?: number | null;
  error?: string | null;
};

/** Load the library's docs + entities with the caller's ACL applied. */
async function loadVisibleEntities(orgId: string, userId: string, libraryId: string): Promise<{
  docs: DocRow[]; entities: EntityRow[]; error?: string;
} > {
  const principal = await loadPrincipal(orgId, userId);
  if (!principal) return { docs: [], entities: [], error: "Not a member of this workspace" };

  const { data: docRows, error: docErr } = await supabaseAdmin
    .from("knowledge_documents")
    .select("id, name, source_document_id, status, page_count, pages_indexed, vision_pages, error")
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
      .select("document_id, page, kind, tag, raw")
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
  // Sheet identities read from each drawing's OWN title block at ingest —
  // the audit's ground truth (filenames are only a fallback).
  const selfByDoc = new Map<string, string[]>();
  for (const e of entities.filter((x) => x.kind === "self")) {
    const list = selfByDoc.get(e.document_id) ?? [];
    if (!list.includes(e.tag)) list.push(e.tag);
    selfByDoc.set(e.document_id, list);
  }

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
  // Site decoder from Library AI setup — names the units behind numbers.
  const { data: libRow } = await supabaseAdmin
    .from("knowledge_libraries").select("ai_features").eq("id", libraryId).maybeSingle();
  const decoder = String(((libRow?.ai_features ?? {}) as Record<string, unknown>).decoder ?? "");
  const unitMap = parseUnitMap(decoder);
  const audit = auditDrawingRefs(
    docs.map((d) => ({ id: d.id, name: d.name })), refsByDoc, selfByDoc, unitMap,
  );

  // ── OPC box pairing (best-effort) ──────────────────────────────────────
  // A connector's box number must reappear on its continuation sheet — the
  // number IS the match, the stream name verifies it. When box numbers were
  // captured (vision transcripts carry them as "OPC n: …"), check each box
  // whose raw line names a loaded sheet: does that sheet have the box?
  const opcRows = entities.filter((e) => e.kind === "opc");
  const opcByDoc = new Map<string, Set<string>>();
  for (const o of opcRows) {
    const set = opcByDoc.get(o.document_id) ?? new Set<string>();
    set.add(o.tag);
    opcByDoc.set(o.document_id, set);
  }
  const identityIndex = new Map<string, Set<string>>();
  for (const [docId, tags] of selfByDoc) {
    for (const t of tags) {
      const set = identityIndex.get(t) ?? new Set<string>();
      set.add(docId);
      identityIndex.set(t, set);
    }
  }
  const opcUnreturned: Array<{ box: string; from: string; to: string; line: string }> = [];
  for (const o of opcRows) {
    if (!o.raw) continue;
    for (const ref of extractDrawingRefs(o.raw)) {
      const owners = identityIndex.get(ref);
      if (!owners || owners.size !== 1) continue;
      const target = [...owners][0];
      if (target === o.document_id) continue;
      if (!(opcByDoc.get(target)?.has(o.tag))) {
        opcUnreturned.push({
          box: o.tag,
          from: nameById.get(o.document_id) ?? "Sheet",
          to: nameById.get(target) ?? "Sheet",
          line: o.raw.slice(0, 120),
        });
      }
    }
  }
  const opcBoxCount = opcRows.length;

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
      `${textlessCount} of ${readyDocs} document(s) have no machine-readable text — typical of scans ` +
      "and of AutoCAD exports that use SHX fonts (text plots as line-work). Hit \"Rebuild index\" with " +
      "your AI key saved: pages without text are READ BY AI VISION during indexing, which makes their " +
      "tags, connectors, and notes fully searchable. (Vision indexing bills to your key and counts " +
      "against your monthly cap.)",
    );
  }
  if (readyDocs > 0 && entities.length === 0 && textlessCount < readyDocs) {
    suggestions.push(
      "These documents have text but no drawing tags were extracted — normal for prose documents. " +
      "If these ARE drawings and were indexed before drawing intelligence existed, hit " +
      "\"Rebuild index\" — it re-reads every page.",
    );
  }
  const declaredCount = docs.filter((d) => selfByDoc.has(d.id)).length;
  if (readyDocs > 0 && declaredCount === 0 && entities.length > 0) {
    suggestions.push(
      "No sheet declared its own drawing number — I couldn't read a \"DRAWING NO\" field from any " +
      "title block, so the reference audit is falling back to filenames. If these sheets were " +
      "indexed before title-block reading existed, hit \"Rebuild index\"; if their borders use " +
      "line-work text, turn on \"Index every page with AI vision\" first.",
    );
  }
  if (census.unknownPrefixes.length > 0) {
    suggestions.push(
      `I found tag prefixes I don't recognize: ${census.unknownPrefixes.slice(0, 8).join(", ")}. ` +
      "Tell me what they mean in Library AI setup → standing instructions (e.g. \"ZZ- means sample " +
      "station\") and answers will categorize them correctly.",
    );
  }
  if (audit.missingInSeries.length > 0) {
    suggestions.push(
      `${audit.missingInSeries.length} sheet(s) from a series you DID load are referenced but absent ` +
      `(${audit.missingInSeries.slice(0, 6).map((m) => m.ref).join(", ")}). Those are gaps in the set — ` +
      "link the folders that hold them and cross-sheet questions stop dead-ending.",
    );
  }
  if (audit.outOfScope.length > 0) {
    const total = audit.outOfScope.reduce((a, o) => a + o.count, 0);
    suggestions.push(
      `${total} connector(s) point to other drawing series (${audit.outOfScope.slice(0, 6)
        .map((o) => `${o.series}${o.unitName ? ` — ${o.unitName}` : ""} ×${o.count}`).join(", ")}). ` +
      "That's normal — this set ends at its battery limits and those units weren't loaded. Nothing " +
      "is broken. To audit those connectors too, add the sheets in those series (highest count = " +
      "biggest payoff); I'll then audit whatever the widened set covers and tell you what the NEXT " +
      "ring of connectors needs.",
    );
  }
  if (audit.outOfScope.length > 0 && !unitMap) {
    suggestions.push(
      "Teach me your numbering scheme in Library AI setup → Drawing number decoder (e.g. \"first " +
      "two digits = unit: 20 = Crude Unit, 25 = Vacuum Unit\") and I'll name the UNITS these " +
      "connectors leave for, not just the numbers.",
    );
  }
  if (opcUnreturned.length > 0) {
    suggestions.push(
      `${opcUnreturned.length} connector box number(s) don't reappear on their continuation sheet — ` +
      "the box number is how a connector pairs, so these are worth a manual look (listed below).",
    );
  }
  if (audit.oneWay.length > 0) {
    suggestions.push(
      `${audit.oneWay.length} connector(s) run one way between sheets that are BOTH loaded — ` +
      "sheet A points at sheet B and B never points back. Some continuation notes are legitimately " +
      "one-way, but this is where real drafting misses hide.",
    );
  }

  // ── Per-sheet readout: what each drawing actually produced ─────────────
  // Guessing why a library "isn't working" is miserable; this is the fact
  // table. Characters extracted, tags found, pages read by vision, per
  // sheet — the answer to "is this an SHX export?" is visible, not argued.
  const charsByDoc = new Map<string, number>();
  const tagsByDoc = new Map<string, number>();
  for (const e of entities) {
    if (e.kind === "equipment") tagsByDoc.set(e.document_id, (tagsByDoc.get(e.document_id) ?? 0) + 1);
  }
  {
    const ids = docs.map((d) => d.id);
    for (let i = 0; i < ids.length; i += 50) {
      const { data } = await supabaseAdmin
        .from("knowledge_chunks").select("document_id, content")
        .in("document_id", ids.slice(i, i + 50)).limit(20000);
      for (const c of (data ?? []) as Array<{ document_id: string; content: string }>) {
        charsByDoc.set(c.document_id, (charsByDoc.get(c.document_id) ?? 0) + (c.content?.length ?? 0));
      }
    }
  }
  const sheets = docs.map((d) => {
    const chars = charsByDoc.get(d.id) ?? 0;
    const tags = tagsByDoc.get(d.id) ?? 0;
    const visionPages = Number(d.vision_pages ?? 0);
    const verdict =
      d.status === "error" ? "error"
      : d.status !== "ready" ? "indexing"
      : visionPages > 0 ? "vision"           // AI read it — SHX/scan handled
      : tags > 0 ? "text"                    // text layer carried the tags
      : chars > 0 ? "text-no-tags"           // readable text, no tags found
      : "empty";                             // nothing at all came out
    const selfTags = selfByDoc.get(d.id) ?? [];
    const base = selfTags.filter((t) => !/-SH\d+$/.test(t)).sort((a, b) => a.length - b.length)[0] ?? null;
    const sheetsDeclared = selfTags.filter((t) => /-SH\d+$/.test(t)).length;
    return {
      id: d.id,
      name: d.name,
      status: d.status,
      pages: Number(d.page_count ?? 0),
      pagesIndexed: Number(d.pages_indexed ?? 0),
      chars, tags, visionPages, verdict,
      // What the title block itself says this sheet is.
      declared: base ? (sheetsDeclared > 1 ? `${base} (${sheetsDeclared} sh)` : base) : null,
      error: d.error ?? null,
    };
  }).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  return NextResponse.json({
    sheetCount: docs.length,
    readyCount: readyDocs,
    textlessCount,
    census,
    audit,
    suggestions,
    sheets,
    opcBoxCount,
    opcUnreturned: opcUnreturned.slice(0, 25),
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
