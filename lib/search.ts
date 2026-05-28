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
import type { DocumentStatus } from "@/types/schema";
import type { Asset } from "@/lib/assets";

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
  status?: DocumentStatus | DocumentStatus[];
  limit?: number;
}

/** Search documents by free-text + scope filters. Falls back to a plain
 *  scoped list when `query` is empty. RLS still applies — callers only
 *  see rows for orgs they're a member of. */
export async function searchDocuments(params: DocumentSearchParams): Promise<DocumentRow[]> {
  const { orgId, query, libraryId, collectionId, plantId, unitId, systemId, status, limit = 50 } = params;
  const trimmed = (query ?? "").trim();

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
  if (status) {
    if (Array.isArray(status)) q = q.in("status", status);
    else q = q.eq("status", status);
  }

  if (trimmed) {
    // Supabase exposes Postgres' `@@` operator via .textSearch.
    // type:'plain' = plainto_tsquery (bag-of-words AND, no operators).
    q = q.textSearch("search_tsv", trimmed, { type: "plain", config: "english" });
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
    q = q.textSearch("search_tsv", trimmed, { type: "plain", config: "english" });
  }
  q = q.order("tag", { ascending: true });

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data as Asset[]) ?? [];
}
