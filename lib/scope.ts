// lib/scope.ts — a scope is a resolved id set, not a filter (GAP-306).
//
// "Crude unit — all of this goes here" is CONTAINMENT, not hops. Focusing a
// node and walking N hops pulls in every document touching the unit's
// equipment, then every other unit those documents touch. A scope here is
// resolved ONCE, from persisted rows only (nothing inferred), into the ids it
// contains:
//
//   the unit     the Site Codebook unit (its code), the operational units
//                row mapped to it (units.codebook_code, 20261138) with its
//                systems, and that row's plant (the container it hangs from)
//   equipment    assets filed to it: assets.unit_code = code, assets.unit_id
//                = the mapped row, assets.system_id = one of its systems
//   documents    documents.unit_code = code (the drawing-number decode),
//                documents.unit_id / system_id (operational scope), the
//                documents in the libraries and folders PINNED to the unit
//                (codebook meta.links), and the documents that govern its
//                equipment (document_assets, entity_mentions) — one step and
//                never further: the other equipment those documents touch
//                stays outside, as a boundary stub on the document
//   shelves      the pinned libraries and the bound knowledge library
//
// Every read is the reader's own (client supabase, RLS) and is paged to
// completion up to RESOLVE_CAP per rule; a read that fails or reaches the cap
// marks the scope incomplete and says why — never silent.
//
// It scopes the ASSEMBLY — lib/orgGraph.ts buildOrgGraph(orgId, { scope }) —
// so the graph's caps apply to the unit, not to an org-wide slice filtered
// afterwards (GAP-306 "Do not filter post-assembly"). Consumers: the org
// graph here; next the operating-area page (UnitOpsPanels, I-09 AREA-6) and
// the graph's scope picker (I-14), through one URL key, `unit:<code>`
// (parseScopeParam / formatScopeParam). The place comes first, the filter
// second (99-fix-sequencing Phase 4 — decision in DEC-44, provisional number).

import { supabase } from "@/lib/supabase";
import type { CodebookEntry } from "@/lib/codebook";
import { pageRows, pageIn, isMissingColumn, isMissingRelation, type Filterable, type PgErr } from "@/lib/orgGraph";

/** Per containment rule: past this many ids the scope says it is incomplete. */
export const RESOLVE_CAP = 10000;

export type ScopeKind = "unit";

/** What a scope names — serialisable as `unit:<code>` for a URL. */
export interface ScopeRef { kind: ScopeKind; code: string }

/** `unit:20` → { kind: "unit", code: "20" }; anything else → null. */
export function parseScopeParam(raw: string | null | undefined): ScopeRef | null {
  const s = String(raw ?? "").trim();
  const m = s.match(/^unit:([A-Za-z0-9._-]{1,32})$/);
  return m ? { kind: "unit", code: m[1] } : null;
}

export function formatScopeParam(ref: ScopeRef): string {
  return `${ref.kind}:${ref.code}`;
}

export interface ResolvedScope {
  ref: ScopeRef;
  /** The unit's name — from the Site Codebook (DEC-35: never from code). */
  label: string;
  /** The Site Codebook holds this unit. */
  found: boolean;
  unitCodes: string[];
  unitIds: string[];
  systemIds: string[];
  plantIds: string[];
  assets: string[];
  documents: string[];
  libraries: string[];
  knowledgeLibraries: string[];
  /** How many documents each rule contributed (one document may count under several). */
  why: { decoded: number; filed: number; pinned: number; governing: number };
  /** false when a read failed or a rule reached RESOLVE_CAP. */
  complete: boolean;
  truncations: string[];
}

/** Membership over graph node ids. `libraries` adds the filing libraries of
 *  the documents actually drawn (a document's own library is part of it). */
export function scopeMembership(
  scope: ResolvedScope, extra?: { libraries?: Iterable<string> },
): (nodeId: string) => boolean {
  const sets: Record<string, Set<string>> = {
    cbunit: new Set(scope.unitCodes),
    unit: new Set(scope.unitIds),
    system: new Set(scope.systemIds),
    plant: new Set(scope.plantIds),
    asset: new Set(scope.assets),
    doc: new Set(scope.documents),
    lib: new Set([...scope.libraries, ...(extra?.libraries ?? [])]),
    klib: new Set(scope.knowledgeLibraries),
  };
  return (nodeId: string) => {
    const i = nodeId.indexOf(":");
    if (i <= 0) return false;
    return sets[nodeId.slice(0, i)]?.has(nodeId.slice(i + 1)) ?? false;
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Meta = CodebookEntry["meta"];

/** Resolve one unit's world under the reader's own RLS. */
export async function resolveScope(orgId: string, ref: ScopeRef): Promise<ResolvedScope> {
  const notes: string[] = [];
  let complete = true;
  const code = ref.code;

  const fail = (what: string, e: PgErr) => {
    notes.push(`${what} could not be read (${e.message}) — this scope is incomplete.`);
    complete = false;
  };

  /** Ids of `table` rows matching `narrow`, paged to completion or the cap. */
  const ids = async (table: string, what: string, narrow: (q: Filterable) => Filterable): Promise<string[]> => {
    const r = await pageRows<{ id: string }>(table, "id", orgId, RESOLVE_CAP, narrow);
    if (r.error) {
      if (isMissingColumn(r.error)) {
        // documents.unit_code before 20261138: there is no decode to read yet.
        notes.push("The unit-identity migration (20261138) is not applied — documents are not yet placed by their decoded unit.");
        return [];
      }
      fail(what, r.error);
    }
    if (r.capped) {
      notes.push(`${what}: more than ${RESOLVE_CAP.toLocaleString("en-US")} — this scope is incomplete.`);
      complete = false;
    }
    return r.rows.map((row) => String(row.id));
  };

  // ── The unit ────────────────────────────────────────────────────────
  const cb = await supabase.from("codebook_entries").select("code, label, meta")
    .eq("org_id", orgId).eq("kind", "unit").eq("code", code).maybeSingle();
  if (cb.error && !isMissingRelation(cb.error)) fail("The Site Codebook entry", cb.error);
  const entry = (cb.error ? null : cb.data) as { code: string; label: string; meta: Meta | null } | null;
  const meta: Meta = entry?.meta ?? {};
  const label = entry?.label || `Unit ${code}`;

  let unitIds: string[] = [];
  let plantIds: string[] = [];
  const mapped = await supabase.from("units").select("id, plant_id")
    .eq("org_id", orgId).eq("codebook_code", code).eq("archived", false);
  if (mapped.error) {
    if (isMissingColumn(mapped.error)) {
      notes.push("The unit-identity migration (20261138) is not applied — no operational unit is mapped to this codebook unit yet.");
    } else if (!isMissingRelation(mapped.error)) {
      fail("The operational unit mapped to this unit", mapped.error);
    }
  } else {
    const rows = (mapped.data as Array<{ id: string; plant_id: string | null }> | null) ?? [];
    unitIds = rows.map((r) => r.id);
    plantIds = [...new Set(rows.map((r) => r.plant_id).filter((p): p is string => !!p))];
  }
  const systemIds = unitIds.length === 0 ? [] : await ids("systems", "Its systems", (q) => q.in("unit_id", unitIds).eq("archived", false));

  // ── Equipment filed to it ───────────────────────────────────────────
  const assetSet = new Set<string>([
    ...await ids("assets", "Equipment filed to it", (q) => q.eq("unit_code", code).eq("archived", false)),
    ...(unitIds.length ? await ids("assets", "Equipment in its operational unit", (q) => q.in("unit_id", unitIds).eq("archived", false)) : []),
    ...(systemIds.length ? await ids("assets", "Equipment in its systems", (q) => q.in("system_id", systemIds).eq("archived", false)) : []),
  ]);
  const assets = [...assetSet];

  // ── Documents ───────────────────────────────────────────────────────
  const decoded = await ids("documents", "Documents whose number decodes to it", (q) => q.eq("unit_code", code));
  const filed = new Set<string>([
    ...(unitIds.length ? await ids("documents", "Documents in its operational unit", (q) => q.in("unit_id", unitIds)) : []),
    ...(systemIds.length ? await ids("documents", "Documents in its systems", (q) => q.in("system_id", systemIds)) : []),
  ]);

  const links = (meta.links ?? []).filter((l) => l && l.libraryId);
  const wholeLibraries = [...new Set(links.filter((l) => !l.folderId).map((l) => l.libraryId))];
  const folders = [...new Set(links.map((l) => l.folderId ?? "").filter((f) => UUID.test(f)))];
  const pinned = new Set<string>(
    wholeLibraries.length ? await ids("documents", "Documents in its pinned libraries", (q) => q.in("library_id", wholeLibraries)) : [],
  );
  if (folders.length) {
    // A pinned folder is its whole subtree (collections.path_ids holds the
    // ancestors) — the same coverage rule the knowledge sync uses.
    const sub = new Set<string>(folders);
    for (const f of folders) {
      const r = await pageRows<{ id: string }>("collections", "id", orgId, RESOLVE_CAP, (q) => q.contains("path_ids", [f]));
      if (r.error) fail("Its pinned folders", r.error);
      for (const row of r.rows) sub.add(String(row.id));
    }
    for (const id of await idsIn("documents", "Documents in its pinned folders", "collection_id", [...sub])) pinned.add(id);
  }

  // Documents that govern its equipment: one step, never further.
  const governing = new Set<string>();
  if (assets.length) {
    for (const id of await idsIn("document_assets", "Documents tagged to its equipment", "asset_id", assets, "document_id")) governing.add(id);
    const ment = await pageIn<{ id: string; document_id: string | null; knowledge_document_id: string | null }>(
      "entity_mentions", "id, document_id, knowledge_document_id", orgId, "asset_id", assets, RESOLVE_CAP);
    if (ment.error) fail("Documents that mention its equipment", ment.error);
    if (ment.capped) { notes.push(`Mentions of its equipment: more than ${RESOLVE_CAP.toLocaleString("en-US")} — this scope is incomplete.`); complete = false; }
    const kdocs = new Set<string>();
    for (const m of ment.rows) {
      if (m.document_id) governing.add(String(m.document_id));
      else if (m.knowledge_document_id) kdocs.add(String(m.knowledge_document_id));
    }
    if (kdocs.size) {
      const mirrors = await pageIn<{ id: string; source_document_id: string | null }>(
        "knowledge_documents", "id, source_document_id", orgId, "id", [...kdocs], kdocs.size + 1);
      if (mirrors.error) fail("The indexed copies that mention its equipment", mirrors.error);
      for (const k of mirrors.rows) if (k.source_document_id) governing.add(String(k.source_document_id));
    }
  }

  const documents = [...new Set([...decoded, ...filed, ...pinned, ...governing])];
  if (!entry && unitIds.length === 0) notes.push(`Unit ${code} is not in the Site Codebook — nothing is filed to it.`);

  return {
    ref, label, found: !!entry,
    unitCodes: [code], unitIds, systemIds, plantIds,
    assets, documents,
    libraries: [...new Set(links.map((l) => l.libraryId))],
    knowledgeLibraries: (meta.knowledgeLibraryId ?? "").trim() ? [(meta.knowledgeLibraryId ?? "").trim()] : [],
    why: { decoded: decoded.length, filed: filed.size, pinned: pinned.size, governing: governing.size },
    complete,
    truncations: notes,
  };

  /** `column IN values` → the `pick` column of the matching rows. */
  async function idsIn(table: string, what: string, column: string, values: string[], pick = "id"): Promise<string[]> {
    const r = await pageIn<{ id: string } & Record<string, unknown>>(table, pick === "id" ? "id" : `id, ${pick}`, orgId, column, values, RESOLVE_CAP);
    if (r.error) fail(what, r.error);
    if (r.capped) { notes.push(`${what}: more than ${RESOLVE_CAP.toLocaleString("en-US")} — this scope is incomplete.`); complete = false; }
    return r.rows.map((row) => String(pick === "id" ? row.id : row[pick] ?? "")).filter(Boolean);
  }
}
