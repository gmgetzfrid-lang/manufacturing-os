// lib/assetCategorize.ts — the bridge the registry was missing.
//
// The Site Codebook already KNOWS the org's equipment taxonomy — the import
// wizard read their numbering documents and stored equipment types with tag
// prefixes ("E" → Exchanger). But the registry groups by its own asset_types
// table, so imported knowledge never categorized a single asset and the unit
// hub filled up with "Uncategorized". This module closes that loop:
//
//   plan  — pure: decode every uncategorized tag through the codebook and
//           say exactly what would change (testable, previewable)
//   apply — create the missing asset_types (named by the codebook) and
//           assign type_id per asset
//
// Anything the codebook can't decode is REPORTED, not guessed — the fix is
// teaching the codebook the missing prefix, which then fixes every future
// asset too.

import { supabase } from "@/lib/supabase";
import { typeForTag, type Codebook } from "@/lib/codebook";
import { createAssetType, updateAsset, type Asset, type AssetType } from "@/lib/assets";

export interface CategorizationPlan {
  /** tag → codebook type label, for assets currently uncategorized. */
  assignments: Array<{ assetId: string; tag: string; typeName: string }>;
  /** Codebook labels with no matching asset_types row yet. */
  typesToCreate: string[];
  /** Uncategorized tags the codebook has no prefix for. */
  unmatched: string[];
  alreadyCategorized: number;
}

/** Pure planning: what would auto-categorize do, exactly. */
export function planCategorization(
  assets: Asset[],
  types: AssetType[],
  book: Codebook,
): CategorizationPlan {
  const typeByName = new Map(types.map((t) => [t.name.toLowerCase(), t]));
  const assignments: CategorizationPlan["assignments"] = [];
  const unmatched: string[] = [];
  const typesToCreate = new Set<string>();
  let alreadyCategorized = 0;

  for (const a of assets) {
    if (a.type_id) { alreadyCategorized += 1; continue; }
    const entry = typeForTag(a.tag, book);
    if (!entry || !entry.label.trim()) { unmatched.push(a.tag); continue; }
    const label = entry.label.trim();
    if (!typeByName.has(label.toLowerCase())) typesToCreate.add(label);
    assignments.push({ assetId: a.id, tag: a.tag, typeName: label });
  }
  return {
    assignments,
    typesToCreate: [...typesToCreate].sort(),
    unmatched,
    alreadyCategorized,
  };
}

export interface CategorizationResult {
  categorized: number;
  createdTypes: number;
  unmatched: string[];
  failed: number;
}

/** Execute a plan: create missing categories (codebook-named), then assign.
 *  Per-asset failures are counted, never fatal — one bad row must not stop
 *  a five-hundred-asset sweep. */
export async function applyCategorization(
  orgId: string,
  userId: string,
  plan: CategorizationPlan,
  existingTypes: AssetType[],
): Promise<CategorizationResult> {
  const typeIdByName = new Map(existingTypes.map((t) => [t.name.toLowerCase(), t.id]));
  let createdTypes = 0;
  for (const name of plan.typesToCreate) {
    if (typeIdByName.has(name.toLowerCase())) continue;
    try {
      const t = await createAssetType({ orgId, name, sortOrder: existingTypes.length + createdTypes });
      typeIdByName.set(name.toLowerCase(), t.id);
      createdTypes += 1;
    } catch {
      // A concurrent sweep created it — re-read the name.
      const { data } = await supabase.from("asset_types")
        .select("id, name").eq("org_id", orgId).ilike("name", name).limit(1);
      const row = (data as Array<{ id: string; name: string }> | null)?.[0];
      if (row) typeIdByName.set(name.toLowerCase(), row.id);
    }
  }

  let categorized = 0;
  let failed = 0;
  for (const a of plan.assignments) {
    const typeId = typeIdByName.get(a.typeName.toLowerCase());
    if (!typeId) { failed += 1; continue; }
    try {
      await updateAsset(a.assetId, { type_id: typeId }, userId);
      categorized += 1;
    } catch { failed += 1; }
  }
  return { categorized, createdTypes, unmatched: plan.unmatched, failed };
}
