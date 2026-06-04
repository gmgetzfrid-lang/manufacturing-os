// lib/search.ts
//
// Phase 2 — Operational search read layer.
//
// Thin wrapper over the Postgres tsvector + GIN indexes added in
// migrations/20260607_search_foundation.sql. Designed for the
// concrete questions a refinery user actually asks at a workstation:
//
//   - "find all P&IDs for exchanger E-204"
//   - "drawings touching unit 200 awaiting engineering"
//   - "instruments in the overhead system of the FCC"
//
// The query is a single string in plainto_tsquery form — words AND'd
// together. We expose escape hooks (scope, status, library) as plain
// where-clause filters so the index can still narrow the row set
// before ranking.
//
// We deliberately do NOT build a generic global search box. Phase 2's
// goal is operational retrieval that knows about plants, units,
// and revisions — not a chatbot fuzzy match.
//
// Return shape note: rows come back from Supabase in snake_case. We
// surface them unmodified rather than casting to the camelCase
// DocumentRecord interface, because the rest of the codebase uses
// ad-hoc per-screen row mappers (e.g. fromDocRow in
// app/(protected)/documents/[libraryId]/page.tsx) and silently
// faking the type here would compound that drift. When a unified
// mapper lands we'll re-type the result.

import { supabase } from "@/lib/supabase";
import type { DocumentStatus, TicketStatus } from "@/types/schema";
import type { Asset } from "@/lib/assets";
import { expandQueryToTsquery } from "@/lib/searchSynonyms";

/** Apply full-text search with refinery synonym expansion, falling back to
 *  plainto when expansion yields nothing usable. Returns the (possibly
 *  modified) query builder so call sites read as a one-liner.
 *
 *  Note: omitting `type` makes supabase-js use raw `to_tsquery`, which is what
 *  our pre-built synonym tsquery string needs. The fallback uses plainto. */
function applyTextSearch<T extends {
  textSearch: (col: string, q: string, opts?: { type?: "plain" | "phrase" | "websearch"; config?: string }) => T;
}>(q: T, trimmed: string): T {
  const tsq = expandQueryToTsquery(trimmed);
  if (tsq) return q.textSearch("search_tsv", tsq, { config: "english" });
  return q.textSearch("search_tsv", trimmed, { type: "plain", config: "english" });
}

/** Raw documents row as returned by Postgres — snake_case, untransformed. */
export interface DocumentRow {
  id: string;
  org_id: string | null;
  library_id: string;
  collection_id: string | null;
  set_id: string | null;
  document_number: string | null;
  name: string | null;
  title: string | null;
  rev: string | null;
  revision: string | null;
  status: string | null;
  current_version_id: string | null;
  plant_id: string | null;
  unit_id: string | null;
  system_id: string | null;
  updated_at: string | null;
  created_at: string | null;
  [extra: string]: unknown;
}

export interface DocumentSearchParams {
  orgId: string;
  /** Free-text query. Empty string returns scope-filtered list without ranking. */
  query?: string;
  libraryId?: string;
  collectionId?: string;
  plantId?: string;
  unitId?: string;
  systemId?: string;
  /** Phase 2 completion — filter to documents linked to a project via
   *  the project_documents join table (auto-populated from checkouts). */
  projectId?: string;
  status?: DocumentStatus | DocumentStatus[];
  limit?: number;
}

/** Search documents by free-text + scope filters. Falls back to a plain
 *  scoped list when `query` is empty. RLS still applies — callers only
 *  see rows for orgs they're a member of. */
export async function searchDocuments(params: DocumentSearchParams): Promise<DocumentRow[]> {
  const { orgId, query, libraryId, collectionId, plantId, unitId, systemId, projectId, status, limit = 50 } = params;
  const trimmed = (query ?? "").trim();

  // Project filter: first resolve the document_id set via project_documents,
  // then narrow the documents query. Two round-trips, but the join-table
  // shape doesn't fit cleanly into supabase-js's foreign-key embed syntax
  // for free-text search, and the document_id set is small (~hundreds).
  let projectDocIds: string[] | null = null;
  if (projectId) {
    const { data, error } = await supabase
      .from("project_documents")
      .select("document_id")
      .eq("project_id", projectId);
    if (error) throw new Error(error.message);
    projectDocIds = ((data as Array<{ document_id: string }>) ?? []).map((r) => r.document_id);
    if (projectDocIds.length === 0) return [];
  }

  let q = supabase
    .from("documents")
    .select("*")
    .eq("org_id", orgId)
    .limit(limit);

  if (libraryId) q = q.eq("library_id", libraryId);
  if (collectionId) q = q.eq("collection_id", collectionId);
  if (plantId) q = q.eq("plant_id", plantId);
  if (unitId) q = q.eq("unit_id", unitId);
  if (systemId) q = q.eq("system_id", systemId);
  if (projectDocIds) q = q.in("id", projectDocIds);
  if (status) {
    if (Array.isArray(status)) q = q.in("status", status);
    else q = q.eq("status", status);
  }

  if (trimmed) {
    q = applyTextSearch(q, trimmed);
  }
  q = q.order("updated_at", { ascending: false, nullsFirst: false });

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data as DocumentRow[]) ?? [];
}

export interface AssetSearchParams {
  orgId: string;
  query?: string;
  typeId?: string;
  plantId?: string;
  unitId?: string;
  systemId?: string;
  archived?: boolean;
  limit?: number;
}

export async function searchAssets(params: AssetSearchParams): Promise<Asset[]> {
  const { orgId, query, typeId, plantId, unitId, systemId, archived, limit = 50 } = params;
  const trimmed = (query ?? "").trim();

  let q = supabase.from("assets").select("*").eq("org_id", orgId).limit(limit);

  if (typeId) q = q.eq("type_id", typeId);
  if (plantId) q = q.eq("plant_id", plantId);
  if (unitId) q = q.eq("unit_id", unitId);
  if (systemId) q = q.eq("system_id", systemId);
  if (archived === false) q = q.eq("archived", false);

  if (trimmed) {
    q = applyTextSearch(q, trimmed);
  }
  q = q.order("tag", { ascending: true });

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data as Asset[]) ?? [];
}

// ─── Revisions ──────────────────────────────────────────────────
//
// Search across document_versions — the canonical revision lineage
// (see docs/ARCHITECTURE.md). Answers questions like "find revisions
// modified during TAR" (matches in change_log) or "what did Smith
// approve last quarter" (matches in approved_by_name).

export interface RevisionRow {
  id: string;
  org_id: string | null;
  record_id: string;
  revision_label: string;
  issue_type: string | null;
  change_type: string | null;
  change_log: string | null;
  moc_reference: string | null;
  source_file_name: string | null;
  drawn_by_name: string | null;
  checked_by_name: string | null;
  approved_by_name: string | null;
  created_by_name: string | null;
  released_at: string | null;
  created_at: string;
  [extra: string]: unknown;
}

export interface RevisionSearchParams {
  orgId: string;
  query?: string;
  /** Filter to one document's revision history. */
  documentId?: string;
  /** ISO timestamp lower bound on released_at (or created_at if no release). */
  releasedAfter?: string;
  /** ISO timestamp upper bound. */
  releasedBefore?: string;
  limit?: number;
}

export async function searchRevisions(params: RevisionSearchParams): Promise<RevisionRow[]> {
  const { orgId, query, documentId, releasedAfter, releasedBefore, limit = 50 } = params;
  const trimmed = (query ?? "").trim();

  let q = supabase.from("document_versions").select("*").eq("org_id", orgId).limit(limit);
  if (documentId) q = q.eq("record_id", documentId);
  if (releasedAfter) q = q.gte("released_at", releasedAfter);
  if (releasedBefore) q = q.lte("released_at", releasedBefore);
  if (trimmed) q = applyTextSearch(q, trimmed);
  q = q.order("released_at", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false });

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data as RevisionRow[]) ?? [];
}

// ─── Tickets ────────────────────────────────────────────────────
//
// Search across drafting tickets. Covers questions like "drawings
// awaiting engineering over 7 days" — combine query="" with
// status="PENDING_ENG_INITIAL" + createdBefore=now-7d, then sort by
// created_at.

export interface TicketRow {
  id: string;
  org_id: string;
  ticket_id: string;
  title: string;
  description: string | null;
  unit: string | null;
  request_type: string;
  status: string;
  priority: number | null;
  requester_id: string;
  requester_name: string | null;
  assigned_drafter_id: string | null;
  assigned_drafter_name: string | null;
  assigned_engineer_id: string | null;
  assigned_engineer_name: string | null;
  target_completion_at: string | null;
  created_at: string;
  last_modified: string | null;
  updated_at: string | null;
  [extra: string]: unknown;
}

export interface TicketSearchParams {
  orgId: string;
  query?: string;
  status?: TicketStatus | TicketStatus[];
  assignedDrafterId?: string;
  assignedEngineerId?: string;
  requesterId?: string;
  /** ISO timestamp — created at or before this point. */
  createdBefore?: string;
  /** ISO timestamp — created at or after this point. */
  createdAfter?: string;
  limit?: number;
}

export async function searchTickets(params: TicketSearchParams): Promise<TicketRow[]> {
  const { orgId, query, status, assignedDrafterId, assignedEngineerId, requesterId, createdBefore, createdAfter, limit = 50 } = params;
  const trimmed = (query ?? "").trim();

  let q = supabase.from("tickets").select("*").eq("org_id", orgId).limit(limit);
  if (status) {
    if (Array.isArray(status)) q = q.in("status", status);
    else q = q.eq("status", status);
  }
  if (assignedDrafterId) q = q.eq("assigned_drafter_id", assignedDrafterId);
  if (assignedEngineerId) q = q.eq("assigned_engineer_id", assignedEngineerId);
  if (requesterId) q = q.eq("requester_id", requesterId);
  if (createdBefore) q = q.lte("created_at", createdBefore);
  if (createdAfter) q = q.gte("created_at", createdAfter);
  if (trimmed) q = applyTextSearch(q, trimmed);
  q = q.order("last_modified", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false });

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data as TicketRow[]) ?? [];
}

// ─── Hold-state search (Phase 5) ───────────────────────────────
//
// Answers questions like "show all open holds for exchanger E-204"
// (combine an asset tag search with a hold filter) or "everything
// blocked on Vendor Data older than 7 days." Returns the
// document_holds row directly; callers can join through to
// documents/assets as needed.

export interface HoldRow {
  id: string;
  org_id: string;
  document_id: string;
  reason: string;
  notes: string | null;
  expected_release_at: string | null;
  opened_by: string;
  opened_by_name: string | null;
  opened_at: string;
  released_by: string | null;
  released_by_name: string | null;
  released_at: string | null;
  released_reason: string | null;
}

export interface HoldSearchParams {
  orgId: string;
  /** Filter to one reason ("Awaiting Engineering") or several. */
  reason?: string | string[];
  /** Only return open holds. Defaults true. */
  openOnly?: boolean;
  /** ISO timestamp — opened on or before. Use with openOnly=true to
   *  find "stale" holds (e.g. holds open longer than 7 days). */
  openedBefore?: string;
  /** ISO timestamp — opened on or after. */
  openedAfter?: string;
  /** Filter to documents in a specific set of IDs (e.g. the result
   *  of an upstream searchDocuments call). */
  documentIds?: string[];
  limit?: number;
}

export async function searchHolds(params: HoldSearchParams): Promise<HoldRow[]> {
  const { orgId, reason, openOnly = true, openedBefore, openedAfter, documentIds, limit = 100 } = params;

  let q = supabase.from("document_holds").select("*").eq("org_id", orgId).limit(limit);
  if (openOnly) q = q.is("released_at", null);
  if (reason) {
    if (Array.isArray(reason)) q = q.in("reason", reason);
    else q = q.eq("reason", reason);
  }
  if (openedBefore) q = q.lte("opened_at", openedBefore);
  if (openedAfter)  q = q.gte("opened_at", openedAfter);
  if (documentIds && documentIds.length > 0) q = q.in("document_id", documentIds);
  q = q.order("opened_at", { ascending: true });

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data as HoldRow[]) ?? [];
}

// ─── Document relationship search ──────────────────────────────
//
// findRelatedDocuments answers "what else relates to this drawing?"
// Two relationship kinds today:
//   - "scope_sibling": same plant/unit/system (closest match wins —
//     system > unit > plant)
//   - "supersession": rows from document_supersessions where this
//     doc is on either side
//
// Hold-related siblings ("other docs blocked on the same hold") will
// add a third kind in Phase 5.

export type RelatedReason = "scope_sibling" | "supersedes" | "superseded_by";

export interface RelatedDocument {
  document: DocumentRow;
  reason: RelatedReason;
  /** Free-form context, e.g. "Same system: Overhead", "Replaced by REV 4". */
  detail?: string;
}

export async function findRelatedDocuments(documentId: string, opts?: { limit?: number }): Promise<RelatedDocument[]> {
  const limit = opts?.limit ?? 25;

  // 1. Load the source doc to get scope FKs and org_id
  const { data: srcData, error: srcErr } = await supabase
    .from("documents")
    .select("id, org_id, plant_id, unit_id, system_id")
    .eq("id", documentId)
    .maybeSingle();
  if (srcErr) throw new Error(srcErr.message);
  if (!srcData) return [];
  const src = srcData as { id: string; org_id: string; plant_id: string | null; unit_id: string | null; system_id: string | null };

  // 2. Supersession chain — old → new and new → old
  const { data: supData, error: supErr } = await supabase
    .from("document_supersessions")
    .select("superseded_doc_id, replacement_doc_id, reason")
    .or(`superseded_doc_id.eq.${documentId},replacement_doc_id.eq.${documentId}`);
  if (supErr) throw new Error(supErr.message);

  const supersessions = (supData as Array<{ superseded_doc_id: string; replacement_doc_id: string; reason: string | null }>) ?? [];
  const supersessionIds = new Set<string>();
  const supersessionDirection = new Map<string, RelatedReason>();
  const supersessionDetail = new Map<string, string>();
  for (const row of supersessions) {
    if (row.superseded_doc_id === documentId) {
      supersessionIds.add(row.replacement_doc_id);
      supersessionDirection.set(row.replacement_doc_id, "superseded_by");
      if (row.reason) supersessionDetail.set(row.replacement_doc_id, `Superseded by: ${row.reason}`);
    } else {
      supersessionIds.add(row.superseded_doc_id);
      supersessionDirection.set(row.superseded_doc_id, "supersedes");
      if (row.reason) supersessionDetail.set(row.superseded_doc_id, `Supersedes: ${row.reason}`);
    }
  }

  // 3. Scope siblings — narrowest scope first.
  // We deliberately exclude documentId itself and the supersession IDs
  // (so a doc that's both a scope sibling AND in the supersession
  // chain shows up under the more specific supersession reason).
  let siblingScope: { col: "system_id" | "unit_id" | "plant_id"; val: string } | null = null;
  if (src.system_id) siblingScope = { col: "system_id", val: src.system_id };
  else if (src.unit_id) siblingScope = { col: "unit_id", val: src.unit_id };
  else if (src.plant_id) siblingScope = { col: "plant_id", val: src.plant_id };

  let scopeSiblings: DocumentRow[] = [];
  if (siblingScope) {
    let q = supabase
      .from("documents")
      .select("*")
      .eq("org_id", src.org_id)
      .eq(siblingScope.col, siblingScope.val)
      .neq("id", documentId)
      .limit(limit);
    if (supersessionIds.size > 0) {
      q = q.not("id", "in", `(${Array.from(supersessionIds).join(",")})`);
    }
    const { data, error } = await q.order("updated_at", { ascending: false, nullsFirst: false });
    if (error) throw new Error(error.message);
    scopeSiblings = (data as DocumentRow[]) ?? [];
  }

  // 4. Load supersession docs themselves
  let supersessionDocs: DocumentRow[] = [];
  if (supersessionIds.size > 0) {
    const { data, error } = await supabase
      .from("documents")
      .select("*")
      .in("id", Array.from(supersessionIds));
    if (error) throw new Error(error.message);
    supersessionDocs = (data as DocumentRow[]) ?? [];
  }

  // 5. Merge — supersessions first (they're more meaningful), then
  // scope siblings up to the limit.
  const out: RelatedDocument[] = [];
  for (const d of supersessionDocs) {
    const reason = supersessionDirection.get(d.id) ?? "supersedes";
    out.push({ document: d, reason, detail: supersessionDetail.get(d.id) });
  }
  for (const d of scopeSiblings) {
    if (out.length >= limit) break;
    out.push({
      document: d,
      reason: "scope_sibling",
      detail: siblingScope ? `Same ${siblingScope.col.replace("_id","")}` : undefined,
    });
  }
  return out;
}
