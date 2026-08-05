// lib/assetAliases.ts — the names for equipment that no rule can derive.
//
// Tag normalization already handles punctuation and case: E-22, E22 and
// "e 22" are one identity, deterministically, for every asset, on day one.
// What it can NEVER derive is what people actually say and what older
// paperwork calls things:
//
//   "the north furnace"        — a nickname that exists only in heads
//   "F-101"                    — the tag before the '19 renumber
//   "Boiler Feed Water Pump"   — a longhand a report used instead of a tag
//   vendor package names       — what the skid was sold as
//
// Teaching one of these makes it work everywhere at once: tag lookup,
// search, the drawing→equipment bridge, and the link proposer.

import { supabase } from "@/lib/supabase";
import { normalizeTag } from "@/lib/codebook";

export type AliasOrigin = "human" | "extraction" | "vision";

export interface AssetAlias {
  id: string;
  org_id: string;
  asset_id: string;
  alias: string;
  alias_normalized: string;
  origin: AliasOrigin;
  note: string | null;
  created_by_name: string | null;
  created_at: string;
}

export const ALIAS_ORIGIN_LABELS: Record<AliasOrigin, string> = {
  human: "Added by hand",
  extraction: "Read from a drawing",
  vision: "Read from a page image",
};

const missing = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "42P01" || /does not exist/i.test(e.message ?? ""));

export async function listAssetAliases(assetId: string): Promise<AssetAlias[]> {
  const { data, error } = await supabase
    .from("asset_aliases").select("*")
    .eq("asset_id", assetId)
    .order("created_at");
  if (error) {
    if (missing(error)) return [];
    throw new Error(error.message);
  }
  return (data as AssetAlias[]) ?? [];
}

export async function addAssetAlias(input: {
  orgId: string; assetId: string; alias: string;
  origin?: AliasOrigin; note?: string;
  userId?: string; userName?: string;
}): Promise<void> {
  const alias = input.alias.trim();
  if (!alias) return;
  const { error } = await supabase.from("asset_aliases").insert({
    org_id: input.orgId,
    asset_id: input.assetId,
    alias,
    alias_normalized: normalizeTag(alias),
    origin: input.origin ?? "human",
    note: input.note?.trim() || null,
    created_by: input.userId ?? null,
    created_by_name: input.userName ?? null,
  });
  // 23505 — already taught. Nothing to do, nothing to complain about.
  if (error && error.code !== "23505") throw new Error(error.message);
}

export async function removeAssetAlias(id: string): Promise<void> {
  const { error } = await supabase.from("asset_aliases").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

/** Resolve a spoken/typed name to asset ids. Punctuation-blind, same
 *  normalization as tags, so "North Furnace" and "north-furnace" agree. */
export async function resolveAliasToAssetIds(orgId: string, text: string): Promise<string[]> {
  const key = normalizeTag(text);
  if (key.length < 2) return [];
  const { data, error } = await supabase
    .from("asset_aliases").select("asset_id")
    .eq("org_id", orgId).eq("alias_normalized", key).limit(10);
  if (error) return [];
  return [...new Set(((data as Array<{ asset_id: string }>) ?? []).map((r) => r.asset_id))];
}

/** Every alias for a set of assets, for display next to their tags. */
export async function aliasesForAssets(assetIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (assetIds.length === 0) return out;
  const { data, error } = await supabase
    .from("asset_aliases").select("asset_id, alias")
    .in("asset_id", assetIds.slice(0, 150));
  if (error) return out;
  for (const r of (data as Array<{ asset_id: string; alias: string }>) ?? []) {
    (out.get(r.asset_id) ?? out.set(r.asset_id, []).get(r.asset_id)!).push(r.alias);
  }
  return out;
}
