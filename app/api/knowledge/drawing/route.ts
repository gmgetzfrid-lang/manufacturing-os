// /api/knowledge/drawing — the deterministic answers layer for drawing
// libraries. Counting vessels or auditing off-page references is DATA work,
// not retrieval work — this route computes from knowledge_page_entities:
//
//   GET  ?orgId&libraryId&action=census   → equipment census by category,
//                                           drawing-ref audit (resolved vs
//                                           missing), suggestions
//   GET  ?orgId&libraryId&action=export   → the equipment register as CSV
//                                           (opens straight into Excel)
//   POST { orgId, libraryId, action:"record-audit" }
//                                         → recompute the audit and COMMIT a
//                                           verdict per sheet to
//                                           drawing_audit_logs, keyed by
//                                           (sheet, revision) so an unrevised
//                                           sheet is never re-audited
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
import { TAG_ENTITY_KINDS } from "@/lib/knowledgeEntityKinds";
import { loadPrincipal, readableControlledDocIds } from "@/lib/knowledgeAccess";
import {
  buildEquipmentCensus, auditDrawingRefs, auditOpcBoxes, equipmentRegisterCsv,
  parseUnitMap, parsePrefixMap,
} from "@/lib/drawingText";
import { loadCodebookAdmin, codebookToDecoderText } from "@/lib/codebookServer";
import { verdictsForSheets, verdictRows, type AuditSheet } from "@/lib/drawingAuditLog";

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
      .in("kind", TAG_ENTITY_KINDS as unknown as string[])
      .order("document_id", { ascending: true })
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

  // Site decoder: the library's own AI-setup decoder, or (when it has none)
  // the org's Site Codebook — unit names AND tag-prefix meanings.
  const { data: libRow } = await supabaseAdmin
    .from("knowledge_libraries").select("ai_features").eq("id", libraryId).maybeSingle();
  const libDecoder = String(((libRow?.ai_features ?? {}) as Record<string, unknown>).decoder ?? "").trim();
  const decoder = libDecoder || codebookToDecoderText(await loadCodebookAdmin(supabaseAdmin, orgId));
  const unitMap = parseUnitMap(decoder);
  const prefixLabels = parsePrefixMap(decoder);

  // ── CSV register download ──────────────────────────────────────────────
  if (action === "export") {
    const csv = equipmentRegisterCsv(equipment.map((e) => ({
      tag: e.tag, documentName: nameById.get(e.document_id) ?? "Sheet", page: e.page,
    })), prefixLabels);
    return new NextResponse(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="equipment-register.csv"`,
      },
    });
  }

  // ── Census + reference audit + suggestions ─────────────────────────────
  const census = buildEquipmentCensus(equipment, prefixLabels);
  const refsByDoc = new Map<string, string[]>();
  for (const r of refs) {
    const list = refsByDoc.get(r.document_id) ?? [];
    list.push(r.tag);
    refsByDoc.set(r.document_id, list);
  }
  const audit = auditDrawingRefs(
    docs.map((d) => ({ id: d.id, name: d.name })), refsByDoc, selfByDoc, unitMap,
  );

  // ── OPC box pairing (best-effort) ──────────────────────────────────────
  const opcRows = entities.filter((e) => e.kind === "opc");
  const opc = auditOpcBoxes(opcRows, selfByDoc, nameById);
  const { boxCount: opcBoxCount, unreturned: opcUnreturned, noRef: opcNoRef } = opc;


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
  if (opcNoRef.length > 0) {
    suggestions.push(
      `${opcNoRef.length} off-page connector(s) carry NO drawing number at all — broken by ` +
      "definition: nothing tells the reader where to continue. Listed below with sheet and page.",
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
    // Pages the entity index has NOTHING for. On a drawing set this is the
    // fingerprint of an interrupted vision rebuild: the transcripts that DID
    // run produced tags, and the skipped pages produced silence — which then
    // surfaces far away as 'X-35 is not in the tag index' on a trace, with
    // no visible reason. Naming the exact pages turns that mystery into a
    // one-line instruction: rebuild, and let it finish.
    const covered = new Set(
      entities.filter((e) => e.document_id === d.id).map((e) => e.page));
    const gapPages: number[] = [];
    for (let pg = 1; pg <= Number(d.page_count ?? 0); pg++) {
      if (!covered.has(pg)) gapPages.push(pg);
    }
    return {
      id: d.id,
      name: d.name,
      status: d.status,
      pages: Number(d.page_count ?? 0),
      pagesIndexed: Number(d.pages_indexed ?? 0),
      gapPages: gapPages.slice(0, 24),
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
    opcNoRef: opcNoRef.slice(0, 25),
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
    return bad("Only Admin or Doc Control can rebuild the index or record an audit.", 403);
  }

  if (body.action === "record-audit") return recordAudit(orgId, libraryId, user.id);
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

/**
 * Commit this library's reference audit to the permanent record.
 *
 * The audit itself is recomputed rather than trusted from the client — a
 * verdict somebody can POST is a verdict nobody can rely on. Rows are keyed
 * (org, sheet number, revision), so re-running is idempotent and a sheet
 * that has since been revised gets its own row rather than overwriting the
 * history of the drawing it replaced.
 */
async function recordAudit(orgId: string, libraryId: string, userId: string) {
  const { docs, entities, error } = await loadVisibleEntities(orgId, userId, libraryId);
  if (error === "migration-missing") {
    return bad("Drawing intelligence needs migration 20260921 — run it, then rebuild the index.", 424);
  }
  if (error) return bad(error, 500);
  if (docs.length === 0) return NextResponse.json({ recorded: 0, sheets: [] });

  const nameById = new Map(docs.map((d) => [d.id, d.name]));
  const selfByDoc = new Map<string, string[]>();
  for (const e of entities.filter((x) => x.kind === "self")) {
    const list = selfByDoc.get(e.document_id) ?? [];
    if (!list.includes(e.tag)) list.push(e.tag);
    selfByDoc.set(e.document_id, list);
  }
  const refsByDoc = new Map<string, string[]>();
  for (const r of entities.filter((e) => e.kind === "ref")) {
    const list = refsByDoc.get(r.document_id) ?? [];
    list.push(r.tag);
    refsByDoc.set(r.document_id, list);
  }

  const audit = auditDrawingRefs(docs.map((d) => ({ id: d.id, name: d.name })), refsByDoc, selfByDoc);
  const opc = auditOpcBoxes(entities.filter((e) => e.kind === "opc"), selfByDoc, nameById);

  // The revision a verdict is filed under has to be the revision that was
  // actually read. It comes from the controlled document the sheet mirrors;
  // a library-only PDF has none, and "" is recorded rather than guessed.
  const mirrored = docs.map((d) => d.source_document_id).filter((id): id is string => !!id);
  const revById = new Map<string, string>();
  if (mirrored.length > 0) {
    const { data: rows } = await supabaseAdmin
      .from("documents").select("id, rev").eq("org_id", orgId).in("id", mirrored);
    for (const r of rows ?? []) revById.set(r.id as string, String((r as { rev?: string }).rev ?? ""));
  }

  const withEntities = new Set(entities.map((e) => e.document_id));
  const sheets: AuditSheet[] = docs.map((d) => ({
    documentId: d.id,
    controlledDocumentId: d.source_document_id,
    name: d.name,
    // The title block's declared number is the sheet's real identity; the
    // filename is a fallback, because files are named by whoever exported
    // them and borders are drafted.
    sheetNumber: selfByDoc.get(d.id)?.[0] ?? d.name,
    revision: d.source_document_id ? (revById.get(d.source_document_id) ?? "") : "",
    indexed: d.status === "ready" && withEntities.has(d.id),
  }));

  const verdicts = verdictsForSheets(sheets, {
    connectorsWithNoTarget: opc.noRef.map((n) => ({ sheet: n.sheet, box: n.box })),
    unreturnedConnectors: opc.unreturned.map((u) => ({ from: u.from, to: u.to, box: u.box })),
    missingInSeries: audit.missingInSeries.map((m) => ({ ref: m.ref, referencedBy: m.referencedBy })),
    oneWay: audit.oneWay.map((o) => ({ from: o.from, to: o.to })),
  });

  // Two sheets of one set can declare the same number; the unique index would
  // reject the batch outright. Keep the more severe verdict — a clean sheet
  // must never mask a broken one filed under the same number.
  const RANK: Record<string, number> = { skipped: 0, passed: 1, flagged: 2, broken_connectors: 3 };
  const bestByKey = new Map<string, (typeof verdicts)[number]>();
  for (const v of verdicts) {
    const key = `${v.sheetNumber}@${v.revision}`;
    const prior = bestByKey.get(key);
    if (!prior || RANK[v.status] > RANK[prior.status]) bestByKey.set(key, v);
  }
  const deduped = [...bestByKey.values()];

  const { error: writeError } = await supabaseAdmin
    .from("drawing_audit_logs")
    .upsert(verdictRows(orgId, deduped, userId), { onConflict: "org_id,sheet_number,revision_code" });
  if (writeError) {
    const missing = writeError.code === "42P01" || /does not exist/i.test(writeError.message);
    return bad(
      missing
        ? "Audit memory needs migration 20260929 — run it in Supabase, then record the audit again."
        : writeError.message,
      missing ? 424 : 500,
    );
  }

  const counts = deduped.reduce<Record<string, number>>((acc, v) => {
    acc[v.status] = (acc[v.status] ?? 0) + 1;
    return acc;
  }, {});
  return NextResponse.json({
    recorded: deduped.length,
    counts,
    sheets: deduped.map((v) => ({
      sheetNumber: v.sheetNumber, revision: v.revision, status: v.status,
      findings: [...v.details.brokenConnectors, ...v.details.missingReferences, ...v.details.oneWay],
    })),
  });
}
