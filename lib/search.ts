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
import { tagKey } from "@/lib/codebook";
import { expandQueryToTsquery } from "@/lib/searchSynonyms";

/** Equipment-tag identity matching: people type "e22", "E22", "E-22", or
 *  "2030.22" and mean the same asset. The registry already stores the
 *  punctuation-free identity (tag_normalized), so search matches THAT —
 *  nobody should have to remember where the hyphen goes. Short queries only:
 *  a long sentence squashed to alphanumerics would match everything. */
function tagLikeNorm(q: string): string | null {
  const norm = tagKey(q);
  return norm.length >= 2 && norm.length <= 12 && !/\s/.test(q.trim()) ? norm : null;
}

/** Assets reachable by a taught nickname / old tag / vendor name. Exact on
 *  the normalized alias (a phrase match, not a substring sweep) so "north
 *  furnace" resolves but ordinary prose doesn't drag equipment in. Empty on
 *  any failure, including before the alias migration. GAP-310: the key is
 *  the one grammar (tagKey) — the grammar addAssetAlias writes and
 *  20261127 rewrote every existing row into. */
async function assetIdsByAlias(orgId: string, q: string): Promise<string[]> {
  const key = tagKey(q);
  if (key.length < 3) return [];
  try {
    const { data, error } = await supabase
      .from("asset_aliases").select("asset_id")
      .eq("org_id", orgId).eq("alias_normalized", key).limit(20);
    if (error) return [];
    return [...new Set(((data ?? []) as Array<{ asset_id: string }>).map((r) => r.asset_id))];
  } catch {
    return [];
  }
}

/** Document ids whose linked equipment matches the query as a TAG (hyphen /
 *  case / dot insensitive, via the document↔asset graph). Empty on any
 *  failure — this augments text search, never replaces it. */
async function docIdsByEquipmentTag(orgId: string, q: string, cap = 200): Promise<string[]> {
  const norm = tagLikeNorm(q);
  // Aliases are the OTHER way people name equipment — "the north furnace",
  // a pre-renumber tag, a vendor's name. Those are phrases, so they get
  // their own (exact, normalized) lookup rather than the tag-shape gate.
  const aliasIds = await assetIdsByAlias(orgId, q);
  if (!norm && aliasIds.length === 0) return [];
  try {
    let assetIds = aliasIds;
    if (norm) {
      const { data: assets } = await supabase
        .from("assets").select("id")
        .eq("org_id", orgId)
        .or(`tag_normalized.ilike.%${norm}%,code.ilike.%${q.trim().replace(/[%_,]/g, "")}%`)
        .limit(30);
      assetIds = [...new Set([
        ...aliasIds,
        ...((assets ?? []) as Array<{ id: string }>).map((a) => a.id),
      ])];
    }
    if (assetIds.length === 0) return [];
    const { data: links } = await supabase
      .from("document_assets").select("document_id")
      .in("asset_id", assetIds)
      .limit(cap);
    return [...new Set(((links ?? []) as Array<{ document_id: string }>).map((l) => l.document_id))];
  } catch {
    return [];
  }
}

// ─── GAP-311: tag lookup ───────────────────────────────────────────────────

export interface TagLookupHit {
  asset: Pick<Asset, "id" | "tag" | "description" | "unit_code" | "code">;
  /** How the query named the asset: its tag (any format), its site code, or
   *  a taught alias. */
  via: "tag" | "code" | "alias";
  /** The operating area it is filed under, with the codebook's name. */
  unit: { code: string; label: string | null } | null;
  /** Documents the asset appears on (the document↔equipment relation). */
  documents: Array<{ id: string; library_id: string; document_number: string | null; title: string | null }>;
}

/** GAP-311 — "FV-2201 is leaking": the asset, its unit and the drawings it
 *  is on, from what someone typed, with NO AI call — indexed equality reads
 *  only: the one tag grammar on assets.tag_normalized (every tag-format
 *  variant), the exact site code, and the taught alias key. Archived
 *  equipment is not a lookup answer. Empty on anything that is not
 *  tag-shaped enough to be an identity (one character, a paragraph). */
export async function lookupTag(orgId: string, query: string, opts: { documentsPerAsset?: number } = {}): Promise<TagLookupHit[]> {
  const trimmed = query.trim();
  const key = tagKey(trimmed);
  if (key.length < 2 || trimmed.length > 80) return [];
  const perAsset = opts.documentsPerAsset ?? 3;
  const cols = "id, tag, description, unit_code, code, archived";
  type Row = Pick<Asset, "id" | "tag" | "description" | "unit_code" | "code" | "archived">;
  try {
    const [byTag, byCode, aliasIds] = await Promise.all([
      supabase.from("assets").select(cols).eq("org_id", orgId).eq("tag_normalized", key).limit(5),
      /^[0-9][0-9.]*[A-Za-z]{0,2}$/.test(trimmed)
        ? supabase.from("assets").select(cols).eq("org_id", orgId).eq("code", trimmed).limit(5)
        : Promise.resolve({ data: [] as Row[], error: null }),
      assetIdsByAlias(orgId, trimmed),
    ]);
    const found = new Map<string, { row: Row; via: TagLookupHit["via"] }>();
    for (const r of ((byTag.data ?? []) as Row[])) if (!found.has(r.id)) found.set(r.id, { row: r, via: "tag" });
    for (const r of ((byCode.data ?? []) as Row[])) if (!found.has(r.id)) found.set(r.id, { row: r, via: "code" });
    const aliasOnly = aliasIds.filter((id) => !found.has(id));
    if (aliasOnly.length > 0) {
      const { data } = await supabase.from("assets").select(cols).eq("org_id", orgId).in("id", aliasOnly.slice(0, 10));
      for (const r of ((data ?? []) as Row[])) if (!found.has(r.id)) found.set(r.id, { row: r, via: "alias" });
    }
    const live = [...found.values()].filter((f) => !f.row.archived).slice(0, 5);
    if (live.length === 0) return [];

    const unitCodes = [...new Set(live.map((f) => f.row.unit_code).filter((c): c is string => !!c))];
    const labels = new Map<string, string>();
    if (unitCodes.length > 0) {
      const { data } = await supabase.from("codebook_entries").select("code, label")
        .eq("org_id", orgId).eq("kind", "unit").in("code", unitCodes);
      for (const u of ((data ?? []) as Array<{ code: string; label: string }>)) labels.set(u.code, u.label);
    }

    const ids = live.map((f) => f.row.id);
    const { data: links } = await supabase.from("document_assets").select("asset_id, document_id")
      .in("asset_id", ids).limit(perAsset * ids.length * 4);
    const docIdsByAsset = new Map<string, string[]>();
    for (const l of ((links ?? []) as Array<{ asset_id: string; document_id: string }>)) {
      const list = docIdsByAsset.get(l.asset_id) ?? [];
      if (!list.includes(l.document_id) && list.length < perAsset) list.push(l.document_id);
      docIdsByAsset.set(l.asset_id, list);
    }
    const allDocIds = [...new Set([...docIdsByAsset.values()].flat())];
    const docs = new Map<string, TagLookupHit["documents"][number]>();
    if (allDocIds.length > 0) {
      // RLS decides which of them this person may see — an unreadable drawing
      // simply does not come back.
      const { data } = await supabase.from("documents").select("id, library_id, document_number, title")
        .eq("org_id", orgId).in("id", allDocIds);
      for (const d of ((data ?? []) as Array<TagLookupHit["documents"][number]>)) docs.set(d.id, d);
    }
    return live.map(({ row, via }) => ({
      asset: { id: row.id, tag: row.tag, description: row.description, unit_code: row.unit_code ?? null, code: row.code ?? null },
      via,
      unit: row.unit_code ? { code: row.unit_code, label: labels.get(row.unit_code) ?? null } : null,
      documents: (docIdsByAsset.get(row.id) ?? []).map((id) => docs.get(id)).filter((d): d is TagLookupHit["documents"][number] => !!d),
    }));
  } catch {
    return [];
  }
}

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
  /** A plant's documents: filed to it, or decoded to a codebook unit one of
   *  its operational units is mapped to (WIRE-3). */
  plantId?: string;
  /** An operational unit's documents: filed to it, or decoded to the
   *  codebook unit it is mapped to (WIRE-3). There is no systemId: a system
   *  has no decoded identity and no screen files a document to one, so the
   *  filter could only ever return nothing (WIRE-3, removed). */
  unitId?: string;
  /** Phase 2 completion — filter to documents linked to a project via
   *  the project_documents join table (auto-populated from checkouts). */
  projectId?: string;
  status?: DocumentStatus | DocumentStatus[];
  limit?: number;
}

/** WIRE-3: an operational unit's documents are the ones filed to it
 *  (documents.unit_id) AND the ones whose number decodes to the Site
 *  Codebook unit it is mapped to (documents.unit_code — 20261138, DEC-67).
 *  The PostgREST `or` filter for both, or null when the unit is not mapped
 *  (or the database predates the mapping): then unit_id alone. */
export async function unitDocumentFilter(unitId: string): Promise<string | null> {
  const { data, error } = await supabase.from("units").select("codebook_code").eq("id", unitId).maybeSingle();
  if (error) return null;
  const code = String((data as { codebook_code?: string | null } | null)?.codebook_code ?? "").replace(/"/g, "").trim();
  if (!code) return null;
  return `unit_id.eq.${unitId},unit_code.eq."${code}"`;
}

/** WIRE-3: a plant's documents are the ones filed to it (documents.plant_id)
 *  AND the ones decoded to a codebook unit that one of its operational
 *  units is mapped to. Null when none of its units is mapped (or the
 *  database predates the mapping): then plant_id alone. */
export async function plantDocumentFilter(plantId: string): Promise<string | null> {
  const { data, error } = await supabase.from("units").select("codebook_code")
    .eq("plant_id", plantId).eq("archived", false).not("codebook_code", "is", null);
  if (error) return null;
  const codes = [...new Set(((data as Array<{ codebook_code: string | null }> | null) ?? [])
    .map((u) => String(u.codebook_code ?? "").replace(/"/g, "").trim()).filter(Boolean))];
  if (codes.length === 0) return null;
  return `plant_id.eq.${plantId},unit_code.in.(${codes.map((c) => `"${c}"`).join(",")})`;
}

/** Search documents by free-text + scope filters. Falls back to a plain
 *  scoped list when `query` is empty. RLS still applies — callers only
 *  see rows for orgs they're a member of. */
export async function searchDocuments(params: DocumentSearchParams): Promise<DocumentRow[]> {
  const { orgId, query, libraryId, collectionId, plantId, unitId, projectId, status, limit = 50 } = params;
  const trimmed = (query ?? "").trim();
  const unitOr = unitId ? await unitDocumentFilter(unitId) : null;
  const plantOr = plantId ? await plantDocumentFilter(plantId) : null;

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
  if (plantId) q = plantOr ? q.or(plantOr) : q.eq("plant_id", plantId);
  if (unitId) q = unitOr ? q.or(unitOr) : q.eq("unit_id", unitId);
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
  let rows = (data as DocumentRow[]) ?? [];

  // Fallback: the search_tsv index can be unpopulated for some documents (e.g.
  // older ingestions), in which case the tsvector match finds nothing. Retry
  // with a plain ILIKE on the key text columns so document search still works.
  if (rows.length === 0 && trimmed) {
    const safe = trimmed.replace(/[%,()*\\]/g, " ").trim();
    if (safe) {
      const like = `%${safe}%`;
      let q2 = supabase.from("documents").select("*").eq("org_id", orgId).limit(limit);
      if (libraryId) q2 = q2.eq("library_id", libraryId);
      if (collectionId) q2 = q2.eq("collection_id", collectionId);
      if (plantId) q2 = plantOr ? q2.or(plantOr) : q2.eq("plant_id", plantId);
      if (unitId) q2 = unitOr ? q2.or(unitOr) : q2.eq("unit_id", unitId);
      if (projectDocIds) q2 = q2.in("id", projectDocIds);
      if (status) { if (Array.isArray(status)) q2 = q2.in("status", status); else q2 = q2.eq("status", status); }
      q2 = q2
        .or(`document_number.ilike.${like},title.ilike.${like},name.ilike.${like}`)
        .order("updated_at", { ascending: false, nullsFirst: false });
      const { data: d2 } = await q2;
      if (d2 && d2.length > 0) rows = d2 as DocumentRow[];
    }
  }

  // Equipment-tag augmentation: "e22" / "E22" / "E-22" / "2030.22" all find
  // the documents linked to that asset, on top of whatever text search found.
  if (trimmed && rows.length < limit) {
    const tagDocIds = await docIdsByEquipmentTag(orgId, trimmed);
    const fresh = tagDocIds.filter((id) => !rows.some((r) => r.id === id));
    if (fresh.length > 0) {
      let q3 = supabase.from("documents").select("*").eq("org_id", orgId)
        .in("id", fresh.slice(0, 100)).limit(limit - rows.length);
      if (libraryId) q3 = q3.eq("library_id", libraryId);
      if (collectionId) q3 = q3.eq("collection_id", collectionId);
      if (plantId) q3 = plantOr ? q3.or(plantOr) : q3.eq("plant_id", plantId);
      if (unitId) q3 = unitOr ? q3.or(unitOr) : q3.eq("unit_id", unitId);
      if (projectDocIds) q3 = q3.in("id", projectDocIds);
      if (status) { if (Array.isArray(status)) q3 = q3.in("status", status); else q3 = q3.eq("status", status); }
      const { data: d3 } = await q3.order("updated_at", { ascending: false, nullsFirst: false });
      if (d3 && d3.length > 0) rows = [...rows, ...(d3 as DocumentRow[])];
    }
  }

  return rows;
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
  let rows = (data as Asset[]) ?? [];

  // Identity-tolerant fallback: tsvector treats "e22" and "E-22" as
  // different words, but they're the same asset. Match the registry's
  // punctuation-free identity (and the site code) directly.
  const norm = trimmed ? tagLikeNorm(trimmed) : null;
  if (norm && rows.length < limit) {
    let q2 = supabase.from("assets").select("*").eq("org_id", orgId).limit(limit);
    if (typeId) q2 = q2.eq("type_id", typeId);
    if (plantId) q2 = q2.eq("plant_id", plantId);
    if (unitId) q2 = q2.eq("unit_id", unitId);
    if (systemId) q2 = q2.eq("system_id", systemId);
    if (archived === false) q2 = q2.eq("archived", false);
    q2 = q2
      .or(`tag_normalized.ilike.%${norm}%,code.ilike.%${trimmed.replace(/[%_,]/g, "")}%`)
      .order("tag", { ascending: true });
    const { data: d2 } = await q2;
    if (d2 && d2.length > 0) {
      const fresh = (d2 as Asset[]).filter((a) => !rows.some((r) => r.id === a.id));
      rows = [...rows, ...fresh].slice(0, limit);
    }
  }

  return rows;
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
// status="PENDING_ENG_TEAM" + createdBefore=now-7d, then sort by
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
