// lib/assets.ts
//
// Tagged Asset Registry — data layer.
//
// Assets are canonical records for physical things (equipment,
// instruments, valves, etc). Photos are attached to assets. The
// equipment-tag columns on documents become foreign references to
// asset rows by normalized tag.

import { supabase } from "@/lib/supabase";

export interface AssetType {
  id: string;
  org_id: string;
  name: string;
  icon: string | null;
  color: string | null;
  sort_order: number;
}

export interface Asset {
  id: string;
  org_id: string;
  tag: string;
  tag_normalized: string;
  type_id: string | null;
  description: string | null;
  location: string | null;
  library_id: string | null;
  archived: boolean;
  metadata: Record<string, unknown>;
  cover_photo_id: string | null;
  // Phase 1 operational entity graph — nullable, no backfill.
  plant_id: string | null;
  unit_id: string | null;
  system_id: string | null;
  // Phase 8 turnaround whiteboard state.
  whiteboard_state: "pending" | "drafting" | "executing" | "completed" | "blocked";
  created_by: string;
  created_at: string;
  updated_by?: string | null;
  updated_at?: string | null;
}

export type PhotoStatus = "current" | "needs_verification" | "superseded";

export interface AssetPhoto {
  id: string;
  org_id: string;
  asset_id: string;
  file_url: string;
  file_size: number | null;
  content_type: string | null;
  captured_at: string | null;
  caption: string | null;
  status: PhotoStatus;
  status_reason: string | null;
  status_marked_by: string | null;
  status_marked_at: string | null;
  uploaded_by: string;
  uploaded_at: string;
  metadata: Record<string, unknown>;
}

/** Normalize a tag for matching: lowercase, strip non-alphanumerics
 *  except keep digits adjacent. `FE-201` `FE201` `fe 201` all map
 *  to `fe201`. */
export function normalizeTag(tag: string): string {
  return (tag || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// ─── Asset types ────────────────────────────────────────────────

export async function listAssetTypes(orgId: string): Promise<AssetType[]> {
  const { data, error } = await supabase
    .from("asset_types")
    .select("*")
    .eq("org_id", orgId)
    .order("sort_order", { ascending: true });
  if (error) throw new Error(error.message);
  return (data as AssetType[]) ?? [];
}

export async function createAssetType(input: {
  orgId: string;
  name: string;
  icon?: string;
  color?: string;
  sortOrder?: number;
}): Promise<AssetType> {
  const { data, error } = await supabase
    .from("asset_types")
    .insert({
      org_id: input.orgId,
      name: input.name,
      icon: input.icon ?? "box",
      color: input.color ?? "slate",
      sort_order: input.sortOrder ?? 0,
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data as AssetType;
}

// ─── Assets ─────────────────────────────────────────────────────

export async function listAssets(params: {
  orgId: string;
  search?: string;
  typeId?: string;
  libraryId?: string;
  archived?: boolean;
}): Promise<Asset[]> {
  let q = supabase.from("assets").select("*").eq("org_id", params.orgId);
  if (params.typeId) q = q.eq("type_id", params.typeId);
  if (params.libraryId) q = q.eq("library_id", params.libraryId);
  if (params.archived === false) q = q.eq("archived", false);
  if (params.search && params.search.trim()) {
    const s = params.search.trim();
    q = q.or(`tag.ilike.%${s}%,description.ilike.%${s}%,location.ilike.%${s}%`);
  }
  const { data, error } = await q.order("tag", { ascending: true });
  if (error) throw new Error(error.message);
  return (data as Asset[]) ?? [];
}

export async function getAsset(id: string): Promise<Asset | null> {
  const { data, error } = await supabase
    .from("assets")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as Asset | null) ?? null;
}

export async function getAssetByTag(orgId: string, tag: string): Promise<Asset | null> {
  const { data, error } = await supabase
    .from("assets")
    .select("*")
    .eq("org_id", orgId)
    .eq("tag_normalized", normalizeTag(tag))
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as Asset | null) ?? null;
}

export async function createAsset(input: {
  orgId: string;
  tag: string;
  typeId?: string;
  description?: string;
  location?: string;
  libraryId?: string;
  createdBy: string;
}): Promise<Asset> {
  const { data, error } = await supabase
    .from("assets")
    .insert({
      org_id: input.orgId,
      tag: input.tag.trim(),
      tag_normalized: normalizeTag(input.tag),
      type_id: input.typeId ?? null,
      description: input.description ?? null,
      location: input.location ?? null,
      library_id: input.libraryId ?? null,
      created_by: input.createdBy,
      updated_by: input.createdBy,
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data as Asset;
}

export async function updateAsset(id: string, patch: Partial<Pick<Asset, "tag" | "type_id" | "description" | "location" | "library_id" | "archived" | "cover_photo_id">>, updatedBy: string): Promise<void> {
  const update: Record<string, unknown> = {
    ...patch,
    updated_by: updatedBy,
    updated_at: new Date().toISOString(),
  };
  if (patch.tag) update.tag_normalized = normalizeTag(patch.tag);
  const { error } = await supabase.from("assets").update(update).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deleteAsset(id: string): Promise<void> {
  const { error } = await supabase.from("assets").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

// ─── Photos ─────────────────────────────────────────────────────

export async function listAssetPhotos(assetId: string): Promise<AssetPhoto[]> {
  const { data, error } = await supabase
    .from("asset_photos")
    .select("*")
    .eq("asset_id", assetId)
    .order("captured_at", { ascending: false, nullsFirst: false })
    .order("uploaded_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data as AssetPhoto[]) ?? [];
}

export async function getPhotoCounts(orgId: string, assetIds: string[]): Promise<Map<string, number>> {
  if (assetIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from("asset_photos")
    .select("asset_id")
    .eq("org_id", orgId)
    .in("asset_id", assetIds);
  if (error) throw new Error(error.message);
  const counts = new Map<string, number>();
  for (const row of (data as Array<{ asset_id: string }>) ?? []) {
    counts.set(row.asset_id, (counts.get(row.asset_id) || 0) + 1);
  }
  return counts;
}

export async function createPhotoRecord(input: {
  orgId: string;
  assetId: string;
  fileUrl: string;
  fileSize?: number;
  contentType?: string;
  capturedAt?: string;
  caption?: string;
  uploadedBy: string;
}): Promise<AssetPhoto> {
  const { data, error } = await supabase
    .from("asset_photos")
    .insert({
      org_id: input.orgId,
      asset_id: input.assetId,
      file_url: input.fileUrl,
      file_size: input.fileSize ?? null,
      content_type: input.contentType ?? null,
      captured_at: input.capturedAt ?? null,
      caption: input.caption ?? null,
      uploaded_by: input.uploadedBy,
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data as AssetPhoto;
}

export async function updatePhoto(id: string, patch: Partial<Pick<AssetPhoto, "caption" | "captured_at" | "status" | "status_reason">>, markedBy: string): Promise<void> {
  const update: Record<string, unknown> = { ...patch };
  if (patch.status) {
    update.status_marked_by = markedBy;
    update.status_marked_at = new Date().toISOString();
  }
  const { error } = await supabase.from("asset_photos").update(update).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deletePhoto(id: string): Promise<void> {
  const { error } = await supabase.from("asset_photos").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

// ─── Filename-based capture-date parsing ─────────────────────────
/** Try to detect a date from a photo filename. Recognizes:
 *    IMG_20240815_143022.jpg          (YYYYMMDD)
 *    2024-08-15.jpg / 2024_08_15      (ISO-ish)
 *    Photo 2024-08-15 14_30_22.jpg
 *  Returns ISO string or null. */
export function parseCapturedAtFromFilename(filename: string): string | null {
  // YYYYMMDD or YYYY-MM-DD
  const isoMatch = filename.match(/(\d{4})[\-_]?(\d{2})[\-_]?(\d{2})/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    const yr = parseInt(y, 10);
    const mo = parseInt(m, 10);
    const day = parseInt(d, 10);
    if (yr > 2000 && yr < 2100 && mo >= 1 && mo <= 12 && day >= 1 && day <= 31) {
      // Try to grab time too
      const timeMatch = filename.match(/(\d{2})[\-_:](\d{2})[\-_:](\d{2})/);
      if (timeMatch) {
        const [, hh, mm, ss] = timeMatch;
        return new Date(Date.UTC(yr, mo - 1, day, +hh, +mm, +ss)).toISOString();
      }
      return new Date(Date.UTC(yr, mo - 1, day, 12, 0, 0)).toISOString();
    }
  }
  return null;
}

// ─── Photo age categorization ────────────────────────────────────
export function photoAgeCategory(capturedAt: string | null | undefined): {
  category: "fresh" | "aging" | "stale" | "unknown";
  label: string;
  colorClass: string;
} {
  if (!capturedAt) return { category: "unknown", label: "Date unknown", colorClass: "text-slate-400" };
  const ms = Date.now() - new Date(capturedAt).getTime();
  const days = ms / (1000 * 60 * 60 * 24);
  if (days < 180) return { category: "fresh", label: ageLabel(days), colorClass: "text-emerald-500" };
  if (days < 730) return { category: "aging", label: ageLabel(days), colorClass: "text-amber-500" };
  return { category: "stale", label: ageLabel(days), colorClass: "text-red-500" };
}

function ageLabel(days: number): string {
  if (days < 1) return "today";
  if (days < 7) return `${Math.round(days)}d ago`;
  if (days < 30) return `${Math.round(days / 7)}w ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${(days / 365).toFixed(1)}y ago`;
}

// ─── Photo-count hook ────────────────────────────────────────────
// Lightweight cache so a list of tag chips doesn't make N queries.

import { useState, useEffect, useCallback } from "react";

const photoCountCache = new Map<string, number>();
const lookupCache = new Map<string, Asset | null>();      // normalizedTag -> asset
const subscribers = new Set<() => void>();

function notifySubscribers() { subscribers.forEach((fn) => fn()); }

export function useAssetByTag(orgId: string | null | undefined, tag: string): { asset: Asset | null; photoCount: number; loading: boolean } {
  const [, force] = useState(0);
  const [loading, setLoading] = useState(false);
  const key = orgId && tag ? `${orgId}::${normalizeTag(tag)}` : null;

  const reload = useCallback(() => force((x) => x + 1), []);

  useEffect(() => {
    subscribers.add(reload);
    return () => { subscribers.delete(reload); };
  }, [reload]);

  useEffect(() => {
    if (!key || !orgId || !tag) return;
    if (lookupCache.has(key)) return;     // already cached
    setLoading(true);
    let alive = true;
    (async () => {
      try {
        const a = await getAssetByTag(orgId, tag);
        lookupCache.set(key, a);
        if (a) {
          const counts = await getPhotoCounts(orgId, [a.id]);
          photoCountCache.set(a.id, counts.get(a.id) || 0);
        }
      } catch {
        lookupCache.set(key, null);
      } finally {
        if (alive) { setLoading(false); notifySubscribers(); }
      }
    })();
    return () => { alive = false; };
  }, [key, orgId, tag]);

  const asset = key ? (lookupCache.get(key) ?? null) : null;
  const photoCount = asset ? (photoCountCache.get(asset.id) || 0) : 0;
  return { asset, photoCount, loading };
}

/** Manually bust the cache (call after photo upload / asset create). */
export function invalidateAssetCache(): void {
  lookupCache.clear();
  photoCountCache.clear();
  notifySubscribers();
}
