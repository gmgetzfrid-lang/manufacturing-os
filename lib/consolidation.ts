// lib/consolidation.ts
//
// Phase 6 — Scope Consolidation Queue.
//
// Detects overlaps across the org's active checkouts so drafters,
// planners, and DocCtrl can spot duplicate effort BEFORE two people
// finish conflicting revisions of the same physical scope.
//
// "Operational intelligence, not automation." Per the directive we
// NEVER auto-merge, NEVER reassign, NEVER reshape work — we surface
// the signal and let humans decide.
//
// Two overlap kinds today:
//
//   - asset:  Multiple active checkouts on different documents that
//             all reference the same canonical asset (via the Phase 1
//             document_assets join table). E.g. someone redlining a
//             P&ID for exchanger E-204 while someone else is updating
//             the equipment data sheet for E-204.
//
//   - scope:  Multiple active checkouts on different documents that
//             share the same plant_id / unit_id / system_id (Phase 1).
//             E.g. two drafters both editing different drawings in
//             the Overhead System of the FCC.
//
// Same-document overlaps are already represented by the existing
// CheckoutSession.lockId / activeCollaborators mechanism — not new
// here. Same-project overlaps are already shown by the grouped view
// on /checkouts.
//
// Hold/release blockers are surfaced separately via Phase 5's hold
// queue. We deliberately do NOT fold them in here — different
// operational question, different page.

import { supabase } from "@/lib/supabase";
import type { CheckoutSession } from "@/types/schema";

export type OverlapKind = "asset" | "scope";
export type ScopeLevel = "system" | "unit" | "plant";

export interface OverlapBase {
  kind: OverlapKind;
  /** IDs of checkout_sessions involved in this overlap. Always ≥ 2. */
  checkoutIds: string[];
  /** IDs of the affected documents (one per checkout, but multiple
   *  checkouts may name the same doc — deduped here). */
  documentIds: string[];
}

export interface AssetOverlap extends OverlapBase {
  kind: "asset";
  assetId: string;
  assetTag: string;
}

export interface ScopeOverlap extends OverlapBase {
  kind: "scope";
  level: ScopeLevel;
  scopeId: string;
  scopeName: string;     // resolved from plants/units/systems
}

export type ConsolidationOverlap = AssetOverlap | ScopeOverlap;

export interface FindOverlapsInput {
  /** Already-loaded active checkouts. Caller does the listAllActiveCheckouts
   *  fetch so we don't double-fetch. RLS scopes everything to the
   *  caller's org membership, so we don't need an explicit orgId. */
  activeCheckouts: CheckoutSession[];
}

/**
 * Coverage diagnostics — what the detector was actually able to LOOK at. The
 * UI uses these to be honest about WHY there are no collisions: "genuinely
 * clear" (plenty of comparable docs, none overlap) is a very different state
 * from "can't tell" (the checked-out documents aren't linked to any asset or
 * scope, so there's nothing to compare). Conflating the two makes the feature
 * look broken/duplicate when it's just starved of input data.
 */
export interface CoordinationCoverage {
  /** Total active checkout SESSIONS scanned. */
  activeCheckouts: number;
  /** Distinct documents under checkout. */
  documents: number;
  /** Documents linked to ≥1 asset (via document_assets). */
  assetLinkedDocuments: number;
  /** Documents assigned a unit or system (plant is too broad to count). */
  scopedDocuments: number;
  /** Documents the detector can actually compare = asset-linked OR scoped.
   *  Collisions are only possible when this is ≥ 2. */
  comparableDocuments: number;
}

export interface CoordinationAnalysis extends CoordinationCoverage {
  overlaps: ConsolidationOverlap[];
}

/** Backwards-compatible thin wrapper: just the overlaps (used by /checkouts). */
export async function findCheckoutOverlaps(input: FindOverlapsInput): Promise<ConsolidationOverlap[]> {
  return (await analyzeCheckoutCoordination(input)).overlaps;
}

/**
 * Full coordination analysis: the overlap signals PLUS the coverage
 * diagnostics that let the UI explain itself. Always reports coverage (even
 * with < 2 checkouts); only computes overlaps when there are ≥ 2 comparable
 * documents.
 */
export async function analyzeCheckoutCoordination(input: FindOverlapsInput): Promise<CoordinationAnalysis> {
  const { activeCheckouts } = input;

  const docIds = Array.from(new Set(activeCheckouts.map((c) => c.documentId).filter(Boolean)));
  const emptyCoverage: CoordinationCoverage = {
    activeCheckouts: activeCheckouts.length,
    documents: docIds.length,
    assetLinkedDocuments: 0,
    scopedDocuments: 0,
    comparableDocuments: 0,
  };
  if (docIds.length === 0) return { overlaps: [], ...emptyCoverage };

  const [assetLinks, docScopes] = await Promise.all([
    // Resolve every active checkout's document → its asset links
    supabase
      .from("document_assets")
      .select("document_id, asset_id, tag_text")
      .in("document_id", docIds),
    // And each document's plant/unit/system scope
    supabase
      .from("documents")
      .select("id, plant_id, unit_id, system_id")
      .in("id", docIds),
  ]);

  if (assetLinks.error) throw new Error(assetLinks.error.message);
  if (docScopes.error) throw new Error(docScopes.error.message);

  const linkRows = (assetLinks.data as Array<{ document_id: string; asset_id: string; tag_text: string | null }>) ?? [];
  const scopeRows = (docScopes.data as Array<{ id: string; plant_id: string | null; unit_id: string | null; system_id: string | null }>) ?? [];

  // ── Coverage ────────────────────────────────────────────────────
  // What can the detector actually compare? A document is "comparable" if it
  // carries an asset link OR a unit/system scope. With fewer than two
  // comparable documents, collisions are impossible — and the UI says so
  // rather than implying "all clear".
  const assetLinkedDocSet = new Set(linkRows.map((r) => r.document_id));
  const scopedDocSet = new Set(scopeRows.filter((r) => r.unit_id || r.system_id).map((r) => r.id));
  const comparableDocSet = new Set<string>([...assetLinkedDocSet, ...scopedDocSet]);
  const coverage: CoordinationCoverage = {
    activeCheckouts: activeCheckouts.length,
    documents: docIds.length,
    assetLinkedDocuments: assetLinkedDocSet.size,
    scopedDocuments: scopedDocSet.size,
    comparableDocuments: comparableDocSet.size,
  };

  if (activeCheckouts.length < 2) return { overlaps: [], ...coverage };

  // ── Asset overlaps ──────────────────────────────────────────────
  // Group checkouts by asset_id: any group with ≥ 2 distinct
  // documents is an overlap. We hit ≥ 2 *documents* (not just ≥ 2
  // checkouts) because two co-checkouts on the same doc are the
  // collaborative-session case, not the consolidation case.
  const docToAssets = new Map<string, Set<string>>();
  const assetTag = new Map<string, string>();
  for (const row of linkRows) {
    let s = docToAssets.get(row.document_id);
    if (!s) { s = new Set(); docToAssets.set(row.document_id, s); }
    s.add(row.asset_id);
    if (row.tag_text) assetTag.set(row.asset_id, row.tag_text);
  }

  const checkoutByDoc = new Map<string, CheckoutSession[]>();
  for (const c of activeCheckouts) {
    if (!c.documentId) continue;
    const arr = checkoutByDoc.get(c.documentId) ?? [];
    arr.push(c);
    checkoutByDoc.set(c.documentId, arr);
  }

  const assetGroups = new Map<string, { docIds: Set<string>; checkoutIds: Set<string> }>();
  for (const [docId, assetIds] of docToAssets) {
    const checkouts = checkoutByDoc.get(docId) ?? [];
    for (const aId of assetIds) {
      let g = assetGroups.get(aId);
      if (!g) { g = { docIds: new Set(), checkoutIds: new Set() }; assetGroups.set(aId, g); }
      g.docIds.add(docId);
      for (const co of checkouts) if (co.id) g.checkoutIds.add(co.id);
    }
  }

  // Resolve tag strings we didn't capture from document_assets
  // (assets that have no tag_text on the join row) — one query
  // for the assets table to fill in canonical tags.
  const unknownAssetIds = Array.from(assetGroups.keys()).filter((id) => !assetTag.has(id));
  if (unknownAssetIds.length > 0) {
    const { data } = await supabase.from("assets").select("id, tag").in("id", unknownAssetIds);
    for (const row of (data as Array<{ id: string; tag: string }>) ?? []) {
      assetTag.set(row.id, row.tag);
    }
  }

  const assetOverlaps: AssetOverlap[] = [];
  for (const [assetId, group] of assetGroups) {
    if (group.docIds.size < 2) continue;
    assetOverlaps.push({
      kind: "asset",
      assetId,
      assetTag: assetTag.get(assetId) ?? "(unknown tag)",
      documentIds: Array.from(group.docIds),
      checkoutIds: Array.from(group.checkoutIds),
    });
  }

  // ── Scope overlaps ──────────────────────────────────────────────
  // Group by the tightest scope FK present on the document
  // (system > unit > plant). A document with no scope contributes
  // nothing. Two docs at the same plant but different units don't
  // count as a scope overlap at the plant level — the directive
  // wants "duplicate drafting effort" signal, and "both working
  // somewhere in Plant X" is too noisy.
  const scopeGroups = new Map<string, { level: ScopeLevel; scopeId: string; docIds: Set<string>; checkoutIds: Set<string> }>();

  for (const row of scopeRows) {
    let level: ScopeLevel | null = null;
    let scopeId: string | null = null;
    if (row.system_id) { level = "system"; scopeId = row.system_id; }
    else if (row.unit_id) { level = "unit"; scopeId = row.unit_id; }
    // Plant level intentionally skipped — too broad to be a signal.
    if (!level || !scopeId) continue;
    const key = `${level}:${scopeId}`;
    let g = scopeGroups.get(key);
    if (!g) { g = { level, scopeId, docIds: new Set(), checkoutIds: new Set() }; scopeGroups.set(key, g); }
    g.docIds.add(row.id);
    for (const co of checkoutByDoc.get(row.id) ?? []) if (co.id) g.checkoutIds.add(co.id);
  }

  // Resolve scope names so the UI can render "Overhead System" not
  // "(uuid)". One query per level we found something at.
  const unitIds = Array.from(scopeGroups.values()).filter((g) => g.level === "unit" && g.docIds.size >= 2).map((g) => g.scopeId);
  const systemIds = Array.from(scopeGroups.values()).filter((g) => g.level === "system" && g.docIds.size >= 2).map((g) => g.scopeId);
  const [unitData, systemData] = await Promise.all([
    unitIds.length ? supabase.from("units").select("id, name").in("id", unitIds) : Promise.resolve({ data: [] }),
    systemIds.length ? supabase.from("systems").select("id, name").in("id", systemIds) : Promise.resolve({ data: [] }),
  ]);
  const nameMap = new Map<string, string>();
  for (const row of (unitData.data as Array<{ id: string; name: string }>) ?? []) nameMap.set(`unit:${row.id}`, row.name);
  for (const row of (systemData.data as Array<{ id: string; name: string }>) ?? []) nameMap.set(`system:${row.id}`, row.name);

  const scopeOverlaps: ScopeOverlap[] = [];
  for (const g of scopeGroups.values()) {
    if (g.docIds.size < 2) continue;
    scopeOverlaps.push({
      kind: "scope",
      level: g.level,
      scopeId: g.scopeId,
      scopeName: nameMap.get(`${g.level}:${g.scopeId}`) ?? "(unnamed)",
      documentIds: Array.from(g.docIds),
      checkoutIds: Array.from(g.checkoutIds),
    });
  }

  // Asset overlaps first — they're the more specific signal. Within
  // each kind, biggest groups first.
  const overlaps: ConsolidationOverlap[] = [
    ...assetOverlaps.sort((a, b) => b.checkoutIds.length - a.checkoutIds.length),
    ...scopeOverlaps.sort((a, b) => b.checkoutIds.length - a.checkoutIds.length),
  ];
  return { overlaps, ...coverage };
}
