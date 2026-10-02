// /api/equipment-bridge — the drawing→equipment bridge's control surface.
//
//   GET  ?orgId&libraryId          → suggestion rows for the library's docs
//                                    the CALLER can read (the sweep wizard's
//                                    table), their relation rows (sheet,
//                                    vanished / superseded marks), and how
//                                    many documents were skipped as unreadable
//   POST { action:"sweep", orgId, libraryId, cursor? }
//                                  → recompute the library's documents, one
//                                    bounded page per call (BR-11): returns
//                                    what each document came to (reason
//                                    counts), `nextCursor` and `done`
//   POST { action:"apply", orgId, documentIds, tags? }
//                                  → apply suggestions (registry discovery +
//                                    the document↔equipment relation + the
//                                    column populate when one is mapped)
//   POST { action:"dismiss", orgId, documentId, tags }
//                                  → a person rejects tags (BR-9)
//   POST { action:"vanished", orgId, documentId, tags, decision }
//                                  → a person reviews relations the current
//                                    revision no longer carries (GAP-309)
//   POST { action:"coverage", orgId, unitCode? }
//                                  → the coverage report (GAP-308)
//   POST { action:"discover", orgId, knowledgeDocumentId, tags }
//                                  → the knowledge door: tags on a P&ID
//                                    uploaded straight into a knowledge
//                                    library become discovered assets
//                                    (GAP-307)
//   POST { action:"settings", orgId, libraryId, targetColumnKey, autoApply,
//          defaultUnitCode, createAssets }
//                                  → save the library's bridge mapping
//
// Writer roles only (Admin / DocCtrl / Manager / Supervisor, by the role
// collection — ADD-1) — the bridge writes documents and the registry. BR-1:
// every action that reads or writes a document evaluates the caller's ACL on
// it first (lib/knowledgeAccess loadPrincipal + readableControlledDocIds —
// the same engine as the ask and drawing routes). A document the caller
// cannot read is skipped and counted, never computed, applied or listed
// (decision: skip and report, never widen). The page shows the sweep only to
// the controller tier (isController); the API admits the registry writer
// tier, deliberately — the registry's own write tier (DEC-53) — and the ACL
// check is what keeps a Manager off a library they cannot read.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  computeForDocument, applyForDocument, dismissForDocument, reviewVanished, discoverFromKnowledge,
  loadBridgeConfig, type BridgeConfig, type ComputeReason,
} from "@/lib/equipmentBridgeServer";
import { memberHoldsAny } from "@/lib/roleHeld";
import { loadPrincipal, readableControlledDocIds, type KnowledgePrincipal } from "@/lib/knowledgeAccess";
import { loadCoverage } from "@/lib/bridgeCoverage";

export const runtime = "nodejs";
export const maxDuration = 60;

const WRITER_ROLES = new Set(["Admin", "DocCtrl", "Manager", "Supervisor"]);

/** BR-11: one sweep call stops cleanly before the platform does. */
export const SWEEP_BUDGET_MS = 40_000;
/** Documents one sweep call takes at most (a page of the library). */
export const SWEEP_PAGE = 150;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

async function authWriter(req: NextRequest, orgId: string): Promise<{ userId: string; principal: KnowledgePrincipal } | NextResponse> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Not authenticated", 401);
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (error || !user) return bad("Not authenticated", 401);
  const { data: member } = await supabaseAdmin
    .from("org_members").select("role, roles").eq("org_id", orgId).eq("uid", user.id)
    .eq("status", "active").maybeSingle();
  // ADD-1: authority by the role COLLECTION, never the headline alone.
  if (!member || !memberHoldsAny(member, [...WRITER_ROLES])) return bad("Not permitted", 403);
  const principal = await loadPrincipal(orgId, user.id);
  if (!principal) return bad("Not permitted", 403);
  return { userId: user.id, principal };
}

/** BR-1: the subset of these controlled documents the caller can read —
 *  fails closed (an ACL read that throws reads as nothing readable). */
async function readableOf(principal: KnowledgePrincipal, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  try { return await readableControlledDocIds(principal, ids); }
  catch { return new Set(); }
}

/** The library's live documents, in id order, from `after` (keyset). */
async function libraryDocIds(orgId: string, libraryId: string, after: string | null, limit: number): Promise<{ ids: string[]; error: string | null }> {
  let q = supabaseAdmin.from("documents").select("id")
    .eq("org_id", orgId).eq("library_id", libraryId).neq("status", "Archived")
    .order("id", { ascending: true }).limit(limit);
  if (after) q = q.gt("id", after);
  const { data, error } = await q;
  if (error) return { ids: [], error: error.message };
  return { ids: ((data ?? []) as Array<{ id: string }>).map((d) => d.id), error: null };
}

export async function GET(req: NextRequest) {
  const orgId = req.nextUrl.searchParams.get("orgId") ?? "";
  const libraryId = req.nextUrl.searchParams.get("libraryId") ?? "";
  if (!orgId || !libraryId) return bad("orgId and libraryId required");
  const auth = await authWriter(req, orgId);
  if (auth instanceof NextResponse) return auth;

  // Every live document of the library, paged to the end (BR-11).
  const docList: Array<{ id: string; document_number: string | null; title: string | null; name: string | null }> = [];
  for (let after: string | null = null; ;) {
    let q = supabaseAdmin.from("documents").select("id, document_number, title, name")
      .eq("org_id", orgId).eq("library_id", libraryId).neq("status", "Archived")
      .order("id", { ascending: true }).limit(1000);
    if (after) q = q.gt("id", after);
    const { data, error } = await q;
    if (error) return bad(error.message, 500);
    const batch = (data ?? []) as typeof docList;
    docList.push(...batch);
    if (batch.length < 1000) break;
    after = batch[batch.length - 1].id;
  }
  const readable = await readableOf(auth.principal, docList.map((d) => d.id));
  const visible = docList.filter((d) => readable.has(d.id));
  const ids = visible.map((d) => d.id);

  const rows: Array<Record<string, unknown>> = [];
  const relations: Array<Record<string, unknown>> = [];
  let relationNote: string | null = null;
  for (let i = 0; i < ids.length; i += 100) {
    const slice = ids.slice(i, i + 100);
    const { data } = await supabaseAdmin
      .from("document_equipment_suggestions").select("*")
      .eq("org_id", orgId).in("document_id", slice);
    rows.push(...((data ?? []) as Array<Record<string, unknown>>));
    let rel: { data: unknown; error: { message: string } | null } = await supabaseAdmin.from("document_assets")
      .select("document_id, asset_id, tag_text, sheet_label, pages, vanished_at, superseded_at, source_revision, model")
      .in("document_id", slice).eq("source", "drawing");
    if (rel.error) {
      rel = await supabaseAdmin.from("document_assets").select("document_id, asset_id, tag_text, sheet_label, pages")
        .in("document_id", slice).eq("source", "drawing");
      relationNote = rel.error ? "The document↔equipment relation has no drawing rows yet (migration 20261170 is not applied)." : "Revision marks need migration 20261171.";
    }
    relations.push(...((rel.data ?? []) as Array<Record<string, unknown>>));
  }
  const nameById = new Map(visible.map((d) => [d.id, d.document_number || d.title || d.name || d.id.slice(0, 8)]));

  // Which docs have knowledge twins at all (so the wizard can say "N linked").
  const twins: Array<{ source_document_id: string; status: string }> = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await supabaseAdmin
      .from("knowledge_documents").select("id, source_document_id, status")
      .in("source_document_id", ids.slice(i, i + 100));
    twins.push(...((data ?? []) as typeof twins));
  }

  // BR-3: P&IDs uploaded straight into a knowledge library have no
  // controlled document to feed — counted here, listed by the coverage
  // report (on a sheet, in no list), where their tags can be discovered.
  const { count: uploadOrigin } = await supabaseAdmin.from("knowledge_documents")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId).is("source_document_id", null).eq("status", "ready");

  const { data: lib } = await supabaseAdmin
    .from("libraries").select("equipment_bridge, custom_columns").eq("id", libraryId).maybeSingle();

  return NextResponse.json({
    suggestions: rows.map((r) => ({ ...r, documentLabel: nameById.get(String(r.document_id)) ?? "—" })),
    relations,
    relationNote,
    linkedDocs: twins.map((t) => ({ documentId: t.source_document_id, status: t.status })),
    unreadable: docList.length - visible.length,
    uploadOrigin: uploadOrigin ?? 0,
    bridge: (lib?.equipment_bridge ?? null) as BridgeConfig | null,
    customColumns: lib?.custom_columns ?? [],
  });
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return bad("Invalid JSON body"); }
  const orgId = String(body.orgId ?? "");
  const action = String(body.action ?? "");
  if (!orgId) return bad("orgId required");
  const auth = await authWriter(req, orgId);
  if (auth instanceof NextResponse) return auth;

  if (action === "settings") {
    const libraryId = String(body.libraryId ?? "");
    if (!libraryId) return bad("libraryId required");
    const { data: lib, error: libErr } = await supabaseAdmin.from("libraries").select("id").eq("id", libraryId).eq("org_id", orgId).maybeSingle();
    if (libErr) return bad(libErr.message, 500);
    if (!lib) return bad("No such library in this workspace", 404);
    const prior = await loadBridgeConfig(supabaseAdmin, libraryId);
    const autoApply = body.autoApply === true;
    const cfg: BridgeConfig = {
      targetColumnKey: body.targetColumnKey ? String(body.targetColumnKey) : undefined,
      autoApply,
      defaultUnitCode: body.defaultUnitCode ? String(body.defaultUnitCode) : undefined,
      createAssets: body.createAssets !== false,
      // BR-8: who turned auto-apply on is who an automatic apply's
      // discovered assets name; BR-9: the library's first review is kept.
      autoApplyBy: autoApply ? (prior?.autoApply && prior.autoApplyBy ? prior.autoApplyBy : auth.userId) : undefined,
      reviewedAt: prior?.reviewedAt,
      reviewedBy: prior?.reviewedBy,
    };
    const { error } = await supabaseAdmin.from("libraries")
      .update({ equipment_bridge: cfg }).eq("id", libraryId).eq("org_id", orgId);
    if (error) return bad(error.message, 500);
    return NextResponse.json({ ok: true, bridge: cfg });
  }

  if (action === "sweep") {
    const libraryId = String(body.libraryId ?? "");
    if (!libraryId) return bad("libraryId required");
    const cursor = typeof body.cursor === "string" && body.cursor ? body.cursor : null;
    const started = Date.now();
    const page = await libraryDocIds(orgId, libraryId, cursor, SWEEP_PAGE);
    if (page.error) return bad(page.error, 500);
    const readable = await readableOf(auth.principal, page.ids);
    const counts: Record<ComputeReason | "failed" | "unreadable", number> = {
      computed: 0, no_entities: 0, upload_origin: 0, no_twin: 0, twin_not_ready: 0, twin_stale: 0, not_found: 0, failed: 0, unreadable: 0,
    };
    let last: string | null = cursor;
    let stoppedEarly = false;
    for (const id of page.ids) {
      if (Date.now() - started > SWEEP_BUDGET_MS) { stoppedEarly = true; break; }
      last = id;
      if (!readable.has(id)) { counts.unreadable++; continue; }
      try {
        const r = await computeForDocument(supabaseAdmin, orgId, id, { trigger: "sweep" });
        counts[r.reason]++;
      } catch { counts.failed++; /* per-doc failures never sink the sweep */ }
    }
    const done = !stoppedEarly && page.ids.length < SWEEP_PAGE;
    return NextResponse.json({
      ok: true,
      computed: counts.computed + counts.no_entities,
      counts,
      nextCursor: done ? null : last,
      done,
    });
  }

  if (action === "apply") {
    const documentIds = Array.isArray(body.documentIds) ? body.documentIds.map(String) : [];
    if (documentIds.length === 0) return bad("documentIds required");
    const tags = Array.isArray(body.tags) ? body.tags.map(String) : undefined;
    const slice = documentIds.slice(0, 500);
    const readable = await readableOf(auth.principal, slice);
    const results: Array<Record<string, unknown>> = [];
    let unreadable = 0;
    for (const documentId of slice) {
      if (!readable.has(documentId)) {
        unreadable++;
        results.push({ documentId, skipped: "unreadable" });
        continue;
      }
      try {
        const r = await applyForDocument(supabaseAdmin, { orgId, documentId, userId: auth.userId, tags });
        results.push({ documentId, ...r });
      } catch (e) {
        results.push({ documentId, error: (e as Error).message });
      }
    }
    return NextResponse.json({ ok: true, results, unreadable });
  }

  if (action === "dismiss" || action === "vanished") {
    const documentId = String(body.documentId ?? "");
    const tags = Array.isArray(body.tags) ? body.tags.map(String).filter(Boolean) : [];
    if (!documentId || tags.length === 0) return bad("documentId and tags required");
    const readable = await readableOf(auth.principal, [documentId]);
    if (!readable.has(documentId)) return bad("You cannot read this document, so you cannot review its equipment.", 403);
    try {
      if (action === "dismiss") {
        return NextResponse.json({ ok: true, ...(await dismissForDocument(supabaseAdmin, { orgId, documentId, userId: auth.userId, tags })) });
      }
      const decision = body.decision === "remove" ? "remove" : body.decision === "keep" ? "keep" : null;
      if (!decision) return bad("decision must be remove or keep");
      return NextResponse.json({ ok: true, ...(await reviewVanished(supabaseAdmin, { orgId, documentId, userId: auth.userId, tags, decision })) });
    } catch (e) {
      return bad((e as Error).message, 500);
    }
  }

  if (action === "coverage") {
    const unitCode = typeof body.unitCode === "string" && body.unitCode ? body.unitCode : null;
    try {
      const report = await loadCoverage(supabaseAdmin, orgId, {
        unitCode,
        canRead: (ids) => readableOf(auth.principal, ids),
      });
      return NextResponse.json({ ok: true, report });
    } catch (e) {
      return bad(`The coverage report could not be built: ${(e as Error).message}`, 500);
    }
  }

  if (action === "discover") {
    const knowledgeDocumentId = String(body.knowledgeDocumentId ?? "");
    const tags = Array.isArray(body.tags) ? body.tags.map(String).filter(Boolean) : [];
    if (!knowledgeDocumentId || tags.length === 0) return bad("knowledgeDocumentId and tags required");
    try {
      const r = await discoverFromKnowledge(supabaseAdmin, { orgId, userId: auth.userId, knowledgeDocumentId, tags: tags.slice(0, 500) });
      return NextResponse.json({ ok: true, ...r });
    } catch (e) {
      return bad((e as Error).message, 400);
    }
  }

  return bad(`Unknown action "${action}"`);
}
