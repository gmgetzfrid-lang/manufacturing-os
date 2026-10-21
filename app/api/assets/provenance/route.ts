// /api/assets/provenance — GAP-303 acceptance 1 / GAP-316 (intelligence
// Round G I-32): "how we came to believe this" for ONE asset, for THIS caller.
//
//   GET ?orgId&assetId → AssetProvenance (lib/assetProvenance.ts): how the
//     asset entered the registry, every relation to it — controlled documents
//     (document_assets) and knowledge-library uploads
//     (knowledge_document_assets, 20261235) — with who or what asserted it,
//     and each recorded decision of the equipment sweep that changed a link.
//
// Every read runs AS THE CALLER (callerScopedClient — their own JWT, so row-
// level security decides what comes back: DACL-11's rail on document_assets,
// 20261235's on knowledge_document_assets, the documents and knowledge
// policies, the audit trail's overlay), and every controlled document — a
// linked one, a decision's, a discovery's source, the source of a knowledge
// mirror — is ALSO put to the app's read predicate (lib/knowledgeAccess
// readableControlledDocIds — lib/permissions canReadNode, the I-12
// predicate), which can be stricter than RLS. A relation, a decision or a
// discovery source on a document the reader may not read is not shown and
// not counted. A predicate that cannot decide answers 503 (fails closed — no
// story rather than one that may show what is not theirs to see); any other
// read that fails is SAID in `notes`, never presented as "none" — and the
// section it empties says so too (`linksIncomplete`, `decisionsUnread`). A
// read cut short by its cap is a read that did not finish: the section says
// so the same way, never with a count or a "none" (`linksCapped`,
// `decisionsCapped` — DEC-90 ruling (1), corrected at the second review fix
// pass). Every read is paged in a stable order past the API's own row
// ceiling, and a cap is said only when a row past it exists, so a count is
// exact or the cap is said — never a silently short number (ruled by the
// integrator at the I-32 merge, 2026-10-21, DEC-90).
//
// The service role reads only the caller's identity and the access facts the
// I-12 predicate needs (memberships, teams, libraries, folders, document ACL
// rows — lib/knowledgeAccess loadPrincipal / readableControlledDocIds); no
// relation, decision or name is read through it. Any active member may ask
// (the asset hub is every member's page). No AI call, no write.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { callerScopedClient } from "@/lib/serverAuth";
import {
  loadPrincipal, readableControlledDocIds, PrincipalUnreadableError, PRINCIPAL_UNREADABLE,
} from "@/lib/knowledgeAccess";
import { tagKey } from "@/lib/codebook";
import {
  assembleAssetProvenance, assetCreatorUid, auditNamesAsset, BRIDGE_DECISION_ACTIONS,
  PROVENANCE_ACCESS_UNCHECKED, PROVENANCE_DECISION_CAP, PROVENANCE_DECISION_PAGE, PROVENANCE_LINK_CAP,
  type ProvAuditRow, type ProvDocumentRow, type ProvKnowledgeRow, type ProvRelationRow,
} from "@/lib/assetProvenance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIVATE = { "Cache-Control": "private, no-store" } as const;
const IN_CHUNK = 100;

type PgErr = { code?: string; message?: string } | null;
type Res = { data: unknown; error: PgErr };
type Caller = Exclude<ReturnType<typeof callerScopedClient>, { error: string }>;

const columnMissing = (e: PgErr) => !!e && (e.code === "42703" || e.code === "PGRST204");
const tableMissing = (e: PgErr) => !!e && (e.code === "42P01" || e.code === "PGRST205");

function bad(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: PRIVATE });
}

/** Read with the columns a database may not have yet dropped one step at a
 *  time (42703 / PGRST204 → the next tier); the first other answer is final. */
async function tiered(tiers: readonly string[], read: (cols: string) => PromiseLike<Res>): Promise<Res> {
  let r: Res = { data: null, error: { message: "no read" } };
  for (const cols of tiers) {
    r = await read(cols);
    if (!columnMissing(r.error)) return r;
  }
  return r;
}

/** One relation read (document_assets / knowledge_document_assets), paged
 *  in a stable order (created_at, then id) with `.range()` windows until
 *  every row the caller may list is in hand or PROVENANCE_LINK_CAP are
 *  (DEC-90, I-32 merge ruling). The first window also asks for the exact
 *  count of the caller's rows, so a window the API's own row ceiling
 *  (max-rows) cut short is never taken for the end: the read keeps going
 *  until the count is reached or a window comes back empty. `capped` is set
 *  only when more rows exist past the cap — by the count, or, when no count
 *  came back, by a one-row probe past it (a probe that fails is a cap: the
 *  read did not show it finished). Columns a database does not have yet are
 *  dropped one tier at a time on the first window. */
async function pagedRelation(
  tiers: readonly string[],
  window: (cols: string, from: number, to: number, count: boolean) => PromiseLike<Res & { count?: number | null }>,
): Promise<{ rows: ProvRelationRow[]; error: PgErr; capped: boolean; total: number | null; probeError?: string }> {
  let cols = tiers[0];
  let res: Res & { count?: number | null } = { data: null, error: { message: "no read" } };
  for (const c of tiers) {
    cols = c;
    res = await window(c, 0, PROVENANCE_LINK_CAP - 1, true);
    if (!columnMissing(res.error)) break;
  }
  if (res.error) return { rows: [], error: res.error, capped: false, total: null };
  const total = typeof res.count === "number" ? res.count : null;
  const rows: ProvRelationRow[] = [];
  const seen = new Set<string>(); // a row a concurrent insert pushed onto the next window is listed once
  let from = 0;
  for (;;) {
    const page = (res.data ?? []) as ProvRelationRow[];
    if (page.length === 0) break;
    from += page.length;
    for (const r of page) {
      const id = r.id ? String(r.id) : null;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      rows.push(r);
    }
    if (from >= PROVENANCE_LINK_CAP || (total !== null && from >= total)) break;
    res = await window(cols, from, PROVENANCE_LINK_CAP - 1, false);
    if (res.error) return { rows, error: res.error, capped: false, total };
  }
  if (from < PROVENANCE_LINK_CAP) return { rows, error: null, capped: false, total };
  if (total !== null) return { rows, error: null, capped: total > PROVENANCE_LINK_CAP, total };
  const probe = await window(cols, PROVENANCE_LINK_CAP, PROVENANCE_LINK_CAP, false);
  if (probe.error) return { rows, error: null, capped: true, total: null, probeError: probe.error.message ?? "the read failed" };
  return { rows, error: null, capped: ((probe.data ?? []) as unknown[]).length > 0, total: null };
}

/** The sentence for a relation read its cap cut short. */
function linksCappedNote(what: string, r: { total: number | null; probeError?: string }): string {
  if (r.total !== null) return `Only the first ${PROVENANCE_LINK_CAP} of the ${r.total} links to ${what} were read — the other ${r.total - PROVENANCE_LINK_CAP} are not shown.`;
  if (r.probeError) return `Only the first ${PROVENANCE_LINK_CAP} links to ${what} were read — whether there are more could not be checked (${r.probeError}).`;
  return `Only the first ${PROVENANCE_LINK_CAP} links to ${what} were read — there are more, not shown.`;
}

async function readIn<T>(caller: Caller, table: string, cols: string, orgId: string, ids: string[]): Promise<{ rows: T[]; error: string | null }> {
  const rows: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const { data, error } = await caller.from(table).select(cols).eq("org_id", orgId).in("id", ids.slice(i, i + IN_CHUNK)) as unknown as Res;
    if (error) return { rows, error: error.message ?? "the read failed" };
    rows.push(...((data ?? []) as T[]));
  }
  return { rows, error: null };
}

export async function GET(req: NextRequest) {
  const orgId = (req.nextUrl.searchParams.get("orgId") ?? "").trim();
  const assetId = (req.nextUrl.searchParams.get("assetId") ?? "").trim();
  if (!orgId || !assetId) return bad("orgId and assetId required", 400);
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Not authenticated", 401);
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authErr || !user) return bad("Not authenticated", 401);
  let principal: Awaited<ReturnType<typeof loadPrincipal>>;
  try {
    principal = await loadPrincipal(orgId, user.id);
  } catch (e) {
    if (e instanceof PrincipalUnreadableError) return bad(PRINCIPAL_UNREADABLE, 503);
    throw e;
  }
  if (!principal) return bad("Not a member of this workspace", 403);
  const caller = callerScopedClient(req);
  if ("error" in caller) return bad(caller.error, caller.status);

  const notes: string[] = [];
  let linksIncomplete = false;
  let decisionsUnread = false;
  let linksCapped = false;
  let decisionsCapped = false;

  // ── The asset (origin / discovered_from: 20260928; created_by: 20260603).
  const assetRes = await tiered(
    ["id, tag, origin, discovered_from, created_at, created_by", "id, tag, created_at, created_by", "id, tag, created_at"],
    (cols) => caller.from("assets").select(cols).eq("org_id", orgId).eq("id", assetId).maybeSingle() as unknown as PromiseLike<Res>,
  );
  if (assetRes.error) return bad(`The equipment could not be read: ${assetRes.error.message ?? "read failed"}`, 500);
  const asset = assetRes.data as { id: string; tag: string; origin?: string | null; discovered_from?: unknown; created_at?: string | null; created_by?: string | null } | null;
  if (!asset) return bad("No such equipment in this workspace", 404);
  const key = tagKey(asset.tag);

  // ── The relations, as the caller (20261170 / 20261171 columns dropped one
  // step at a time), each paged to completion or PROVENANCE_LINK_CAP.
  const relRes = await pagedRelation([
    "id, document_id, tag_text, source, sheet_label, pages, asserted_by, asserted_by_user, model, source_revision, vanished_at, superseded_at, created_at",
    "id, document_id, tag_text, source, sheet_label, pages, created_at",
    "id, document_id, tag_text, source, created_at",
  ], (cols, lo, hi, count) => caller.from("document_assets").select(cols, count ? { count: "exact" } : undefined)
    .eq("org_id", orgId).eq("asset_id", assetId)
    .order("created_at", { ascending: true }).order("id", { ascending: true }).range(lo, hi) as unknown as PromiseLike<Res>);
  let documentRelations: ProvRelationRow[] = [];
  if (relRes.error) {
    linksIncomplete = true;
    notes.push(relRes.rows.length === 0
      ? `The links to controlled documents could not be read (${relRes.error.message ?? "read failed"}) — none of them is shown, which is not the same as none.`
      : `The links to controlled documents could not all be read (${relRes.error.message ?? "read failed"}) — only the first ${relRes.rows.length} are shown.`);
    documentRelations = relRes.rows;
  } else {
    documentRelations = relRes.rows;
    if (relRes.capped) {
      linksCapped = true;
      notes.push(linksCappedNote("controlled documents", relRes));
    }
  }

  let knowledgeRelationInstalled = true;
  let knowledgeRelations: ProvRelationRow[] = [];
  const kRes = await pagedRelation([
    "id, knowledge_document_id, tag_text, source, sheet_label, pages, asserted_by, model, source_revision, created_at",
  ], (cols, lo, hi, count) => caller.from("knowledge_document_assets").select(cols, count ? { count: "exact" } : undefined)
    .eq("org_id", orgId).eq("asset_id", assetId)
    .order("created_at", { ascending: true }).order("id", { ascending: true }).range(lo, hi) as unknown as PromiseLike<Res>);
  if (tableMissing(kRes.error) && kRes.rows.length === 0) {
    // Before 20261235 a knowledge upload's links are not recorded at all.
    knowledgeRelationInstalled = false;
  } else if (kRes.error) {
    linksIncomplete = true;
    notes.push(kRes.rows.length === 0
      ? `The links to knowledge-library uploads could not be read (${kRes.error.message ?? "read failed"}) — none of them is shown, which is not the same as none.`
      : `The links to knowledge-library uploads could not all be read (${kRes.error.message ?? "read failed"}) — only the first ${kRes.rows.length} are shown.`);
    knowledgeRelations = kRes.rows;
  } else {
    knowledgeRelations = kRes.rows;
    if (kRes.capped) {
      linksCapped = true;
      notes.push(linksCappedNote("knowledge-library uploads", kRes));
    }
  }

  // ── The equipment sweep's decisions, as the caller (the audit trail's own
  // policies). The details naming the asset are in more than one shape (an
  // id, a tag in one of several arrays, in any spelling the one tag grammar
  // folds), so the asset's rows are found here, not by the query: the read
  // pages back through the workspace's decisions, newest first, until they
  // run out or PROVENANCE_DECISION_CAP have been searched. A search that
  // reaches the cap asks for ONE more row (DEC-90, I-32 merge ruling): only
  // if it exists were older decisions NOT searched — said in `notes` and by
  // `decisionsCapped`, never as "none". A workspace with exactly the cap's
  // decisions was searched whole. A probe that fails is a cap (the read did
  // not show it finished).
  const audits: ProvAuditRow[] = [];
  const seen = new Set<string>(); // a row a newer insert pushed onto the next page is listed once
  let searched = 0;
  const decisionWindow = (from: number, to: number) => caller.from("audit_logs").select("id, action, resource_type, resource_id, user_id, details, created_at")
    .eq("org_id", orgId).in("action", [...BRIDGE_DECISION_ACTIONS])
    .order("created_at", { ascending: false }).order("id", { ascending: false })
    .range(from, to) as unknown as PromiseLike<Res>;
  for (;;) {
    const audRes = await decisionWindow(searched, Math.min(searched + PROVENANCE_DECISION_PAGE, PROVENANCE_DECISION_CAP) - 1);
    if (audRes.error) {
      decisionsUnread = true;
      notes.push(searched === 0
        ? `The equipment sweep's recorded decisions could not be read (${audRes.error.message ?? "read failed"}) — none is shown, which is not the same as none.`
        : `Only the latest ${searched} of the equipment sweep's recorded decisions could be read (${audRes.error.message ?? "read failed"}) — older ones about this equipment are not shown.`);
      break;
    }
    const page = (audRes.data ?? []) as ProvAuditRow[];
    // An empty page is the end — not a short one: the API's own row ceiling
    // (max-rows) may hand back fewer than asked while more remain.
    if (page.length === 0) break;
    searched += page.length;
    for (const a of page) {
      if (a.id && seen.has(String(a.id))) continue;
      if (a.id) seen.add(String(a.id));
      if (auditNamesAsset(a.details, asset, key)) audits.push(a);
    }
    if (searched >= PROVENANCE_DECISION_CAP) {
      const probe = await decisionWindow(searched, searched);
      if (!probe.error && ((probe.data ?? []) as unknown[]).length === 0) break;
      decisionsCapped = true;
      notes.push(`Only the workspace's latest ${PROVENANCE_DECISION_CAP} equipment-sweep decisions were searched — older ones about this equipment were not searched and are not listed.`);
      break;
    }
  }

  // ── Which documents and uploads the story names.
  const from = asset.discovered_from && typeof asset.discovered_from === "object" ? asset.discovered_from as Record<string, unknown> : null;
  const docIds = new Set<string>();
  const kdocIds = new Set<string>();
  for (const r of documentRelations) if (r.document_id) docIds.add(String(r.document_id));
  for (const r of knowledgeRelations) if (r.knowledge_document_id) kdocIds.add(String(r.knowledge_document_id));
  for (const a of audits) {
    if (!a.resource_id) continue;
    if (a.resource_type === "document") docIds.add(String(a.resource_id));
    else if (a.resource_type === "knowledge_document") kdocIds.add(String(a.resource_id));
  }
  if (from && typeof from.documentId === "string" && from.documentId) docIds.add(from.documentId);
  if (from && typeof from.knowledgeDocumentId === "string" && from.knowledgeDocumentId) kdocIds.add(from.knowledgeDocumentId);

  // As the caller: what RLS lets them list.
  const docsRead = await readIn<ProvDocumentRow>(caller, "documents",
    "id, document_number, title, name, status, library_id, asset_tags", orgId, [...docIds]);
  if (docsRead.error) {
    linksIncomplete = true;
    decisionsUnread = true;
    notes.push(`The linked documents could not be read (${docsRead.error}) — links and decisions on them are not shown.`);
  }
  const kdocsRead = await readIn<ProvKnowledgeRow & { source_document_id?: string | null }>(caller, "knowledge_documents",
    "id, name, library_id, source_document_id", orgId, [...kdocIds]);
  if (kdocsRead.error) {
    linksIncomplete = true;
    decisionsUnread = true;
    notes.push(`The linked knowledge-library uploads could not be read (${kdocsRead.error}) — links and decisions on them are not shown.`);
  }
  const docRows = docsRead.error ? [] : docsRead.rows;
  const kdocRows = kdocsRead.error ? [] : kdocsRead.rows;

  // And the app's read predicate, on every controlled document — a mirror's
  // source too: an upload that mirrors a document the reader may not read is
  // not shown either.
  const askIds = [...new Set([...docRows.map((d) => String(d.id)),
    ...kdocRows.map((k) => k.source_document_id).filter((x): x is string => !!x)])];
  let readable: Set<string>;
  try {
    readable = await readableControlledDocIds(principal, askIds);
  } catch {
    return bad(PROVENANCE_ACCESS_UNCHECKED, 503);
  }
  const readableDocuments = new Map<string, ProvDocumentRow>();
  for (const d of docRows) if (readable.has(String(d.id))) readableDocuments.set(String(d.id), d);
  const readableKnowledge = new Map<string, ProvKnowledgeRow>();
  for (const k of kdocRows) {
    if (k.source_document_id && !readable.has(String(k.source_document_id))) continue;
    readableKnowledge.set(String(k.id), { id: String(k.id), name: k.name ?? null, library_id: k.library_id ?? null });
  }

  // ── Who: the person the registry records as the asset's creator (BR-8's
  // accountable identity), the person who linked a manual row, and each
  // decision's actor — only for what is shown.
  const uids = new Set<string>();
  const creator = assetCreatorUid(asset);
  if (creator) uids.add(creator);
  for (const r of documentRelations) {
    if (r.source === "manual" && r.asserted_by_user && r.document_id && readableDocuments.has(String(r.document_id))) uids.add(String(r.asserted_by_user));
  }
  for (const a of audits) {
    const rid = String(a.resource_id ?? "");
    if (a.user_id && (readableDocuments.has(rid) || readableKnowledge.has(rid))) uids.add(String(a.user_id));
  }
  const names = new Map<string, string>();
  if (uids.size > 0) {
    const ids = [...uids];
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const { data, error } = await caller.from("org_members").select("uid, display_name, email")
        .eq("org_id", orgId).in("uid", ids.slice(i, i + IN_CHUNK)) as unknown as Res;
      if (error) { notes.push("The names of the people who entered, linked or decided could not be read — they are shown as \"a person\"."); break; }
      for (const m of (data ?? []) as Array<{ uid: string; display_name?: string | null; email?: string | null }>) {
        const n = (m.display_name || m.email || "").trim();
        if (n) names.set(String(m.uid), n);
      }
    }
  }

  const story = assembleAssetProvenance({
    asset, documentRelations, knowledgeRelations, readableDocuments, readableKnowledge,
    audits, names, notes, knowledgeRelationInstalled, linksIncomplete, decisionsUnread,
    linksCapped, decisionsCapped,
    // A discovery source the failed read could not list is unread, not hidden.
    documentsUnread: !!docsRead.error, knowledgeUnread: !!kdocsRead.error,
  });
  return NextResponse.json(story, { headers: PRIVATE });
}
