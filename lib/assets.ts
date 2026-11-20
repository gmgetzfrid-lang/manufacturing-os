// lib/assets.ts
//
// Tagged Asset Registry — data layer.
//
// Assets are canonical records for physical things (equipment,
// instruments, valves, etc). Photos are attached to assets. The
// equipment-tag columns on documents become foreign references to
// asset rows by normalized tag.

import { supabase } from "@/lib/supabase";
import { nameKey, sameEquipmentId } from "@/lib/equipmentPick";
import { parseEquipmentLabel, pickEquipment, onePerPiece, idOf, labelKey, type PickWhy } from "@/lib/equipmentIdentity";
import type { WhiteboardState } from "@/types/schema";

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
  // Phase 8 turnaround board / plot-plan operational state.
  whiteboard_state?: WhiteboardState;
  // Site Codebook identity — the asset's two languages. unit_code ties it to
  // a codebook unit ("20"); code is the full site identity ("2030.22");
  // origin records how it entered the registry ('manual' | 'drawing');
  // discovered_from carries the drawing/sheet provenance for discovered rows.
  unit_code?: string | null;
  code?: string | null;
  origin?: "manual" | "drawing";
  discovered_from?: Record<string, unknown> | null;
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
    q = q.or(orIlike(["tag", "description", "location"], s));
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

/** The ways a tag can be stored in tag_normalized: "C-2" is also kept as
 *  "c02" or "c002" (leading zeros don't make another name). */
export function tagNormForms(tag: string): string[] {
  const k = nameKey(tag);
  const out = new Set<string>([normalizeTag(tag.replace(/\s*\(.*$/, "")), k]);
  const m = k.match(/^([a-z]*)(\d+)(.*)$/);
  if (m) for (const pad of ["0", "00"]) out.add(`${m[1]}${pad}${m[2]}${m[3]}`);
  return [...out].filter(Boolean);
}

/** The registry rows a label could mean: by its ID (and an ID kept in an
 *  old name), and by its tag. */
async function candidatesFor(orgId: string, label: { tag: string | null; code: string | null }): Promise<Asset[]> {
  const reads: Array<PromiseLike<{ data: unknown; error: { message: string } | null }>> = [];
  if (label.code) {
    const head = label.code.split(/[.-]/)[0];
    // Quoted: a parenthesis is syntax inside .or() (lib/orFilter).
    reads.push(supabase.from("assets").select("*").eq("org_id", orgId).or(`code.ilike."${head}%",tag.ilike."%(${head}%"`).limit(100));
  }
  if (label.tag) reads.push(supabase.from("assets").select("*").eq("org_id", orgId).in("tag_normalized", tagNormForms(label.tag)).limit(50));
  const out = new Map<string, Asset>();
  for (const { data, error } of await Promise.all(reads)) {
    if (error) throw new Error(error.message);
    for (const a of (data as Asset[] | null) ?? []) out.set(a.id, a);
  }
  return [...out.values()];
}

const asRecord = (a: Asset, photos?: Map<string, number>) => ({
  id: a.id, tag: a.tag, code: a.code ?? null, unitCode: a.unit_code ?? null, origin: a.origin ?? null,
  archived: a.archived, createdAt: a.created_at, photos: photos?.get(a.id) ?? 0, asset: a,
});

export interface EquipmentLookup {
  asset: Asset | null;
  why: PickWhy | "alias";
  /** What it could have been (for saying why it wasn't found). */
  candidates: Asset[];
  units: Array<string | null>;
}

/** The equipment a label means: "X-31 (2030.31)", "2030.31", "X-31". The
 *  ID decides first; then the tag, inside `unitCode` when given (else the
 *  ID's unit). Copies of one piece count once: the one with an ID, then the
 *  one with photos. Two pieces and nothing to tell them apart is no
 *  answer, never a guess (lib/equipmentIdentity). */
export async function resolveEquipment(orgId: string, label: string, unitCode?: string | null): Promise<EquipmentLookup> {
  const want = parseEquipmentLabel(label);
  if (!want.tag && !want.code) return { asset: null, why: "none", candidates: [], units: [] };
  const rows = await candidatesFor(orgId, want);
  // Photos only break a tie between copies of one piece.
  const photos = rows.length > 1 ? await getPhotoCounts(orgId, rows.map((a) => a.id)).catch(() => new Map<string, number>()) : undefined;
  const pick = pickEquipment(rows.map((a) => asRecord(a, photos)), { ...want, unitCode: unitCode ?? null });
  if (pick.asset) return { asset: pick.asset.asset, why: pick.why, candidates: pick.candidates.map((c) => c.asset), units: pick.units };
  if (pick.why === "none") {
    const viaAlias = await aliasHit(orgId, label) ?? (want.tag && want.tag !== label.trim() ? await aliasHit(orgId, want.tag) : null);
    if (viaAlias) return { asset: viaAlias, why: "alias", candidates: [viaAlias], units: [viaAlias.unit_code ?? null] };
  }
  return { asset: null, why: pick.why, candidates: pick.candidates.map((c) => c.asset), units: pick.units };
}

/** The equipment a label names, or null (see resolveEquipment). */
export async function getAssetByTag(orgId: string, tag: string, unitCode?: string | null): Promise<Asset | null> {
  return (await resolveEquipment(orgId, tag, unitCode)).asset;
}

/** Every piece of equipment a label could be: one record per piece (two
 *  copies of X-31 in unit 20 are one), by its ID when it has one. */
export async function findAssetsByTag(orgId: string, tag: string): Promise<Asset[]> {
  const want = parseEquipmentLabel(tag);
  if (!want.tag && !want.code) return [];
  const rows = await candidatesFor(orgId, want);
  const recs = rows.map((a) => asRecord(a));
  if (want.code) {
    const byId = recs.filter((r) => sameEquipmentId(idOf(r), want.code));
    if (byId.length) return onePerPiece(byId).map((r) => r.asset);
  }
  const named = want.tag ? recs.filter((r) => nameKey(r.tag) === nameKey(want.tag)) : [];
  return onePerPiece(named).map((r) => r.asset);
}

/** Two IDs are one when they differ only in leading zeros after the point
 *  (2010.7 and 2010.07). */
export { sameEquipmentId } from "@/lib/equipmentPick";

async function aliasHit(orgId: string, tag: string): Promise<Asset | null> {
  // No canonical match — try what people actually call it. A nickname, a
  // pre-renumber tag or a vendor name resolves to the same hub, so an old
  // link in an email still lands somewhere real.
  const { data: alias } = await supabase
    .from("asset_aliases").select("asset_id")
    .eq("org_id", orgId).eq("alias_normalized", normalizeTag(tag))
    .limit(1).maybeSingle();
  const assetId = (alias as { asset_id?: string } | null)?.asset_id;
  if (!assetId) return null;
  const { data: viaAlias } = await supabase
    .from("assets").select("*").eq("id", assetId).maybeSingle();
  return (viaAlias as Asset | null) ?? null;
}

/** The database's refusals, in words: an ID already used, a name the
 *  database still holds once (before the equipment SQL), or a member who
 *  isn't an admin. */
export function equipmentError(message: string, what: { tag?: string | null; code?: string | null; unitCode?: string | null }): Error {
  if (/assets_unit_name_unique|tag_normalized/.test(message)) return new Error(`The database still allows ${what.tag ?? "a name"} only once for the whole plant. The ID decides, not the name: run the equipment SQL once, then add it again.`);
  if (/assets_code_unique/.test(message)) return new Error(`ID ${what.code ?? ""} is already another piece of equipment.`.replace("ID  is", "That ID is"));
  if (/row-level security|violates row level|permission denied/i.test(message)) return new Error("Only admins can add or change equipment.");
  return new Error(message);
}

export async function createAsset(input: {
  orgId: string;
  tag: string;
  typeId?: string;
  description?: string;
  location?: string;
  libraryId?: string;
  unitCode?: string;
  code?: string;
  createdBy: string;
}): Promise<Asset> {
  const base = {
    org_id: input.orgId,
    tag: input.tag.trim(),
    tag_normalized: normalizeTag(input.tag),
    type_id: input.typeId ?? null,
    description: input.description ?? null,
    location: input.location ?? null,
    library_id: input.libraryId ?? null,
    created_by: input.createdBy,
    updated_by: input.createdBy,
  };
  // Codebook identity columns arrived in 20260928 — retry without them on a
  // pre-migration DB so asset creation never breaks.
  let resp = await supabase.from("assets")
    .insert({ ...base, unit_code: input.unitCode ?? null, code: input.code ?? null })
    .select("*").single();
  if (resp.error && /unit_code|column/i.test(resp.error.message)) {
    resp = await supabase.from("assets").insert(base).select("*").single();
  }
  if (resp.error) throw equipmentError(resp.error.message, { tag: input.tag.trim(), code: input.code, unitCode: input.unitCode });
  return resp.data as Asset;
}

export async function updateAsset(id: string, patch: Partial<Pick<Asset, "tag" | "type_id" | "description" | "location" | "library_id" | "archived" | "cover_photo_id" | "unit_code" | "code">>, updatedBy: string): Promise<void> {
  const update: Record<string, unknown> = {
    ...patch,
    updated_by: updatedBy,
    updated_at: new Date().toISOString(),
  };
  if (patch.tag) update.tag_normalized = normalizeTag(patch.tag);
  // A change the database refuses (not an admin) comes back as no rows, not
  // an error: said, never taken as saved.
  const { data, error } = await supabase.from("assets").update(update).eq("id", id).select("id");
  if (error) throw equipmentError(error.message, { tag: patch.tag, code: patch.code, unitCode: patch.unit_code });
  if (Array.isArray(data) && data.length === 0) throw new Error("Only admins can add or change equipment.");
}

export async function deleteAsset(id: string): Promise<void> {
  const { data, error } = await supabase.from("assets").delete().eq("id", id).select("id");
  if (error) throw equipmentError(error.message, {});
  if (Array.isArray(data) && data.length === 0) throw new Error("Only admins can add or change equipment.");
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

/** One batched read for the card grids: each asset's cover photo URL (its
 *  designated cover, else its newest photo). Replaces the per-card
 *  listAssetPhotos waterfall — 60 photographed assets used to mean 60
 *  queries on page open. */
export async function getCoverPhotoUrls(
  assets: Array<{ id: string; cover_photo_id?: string | null }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = assets.map((a) => a.id);
  if (ids.length === 0) return out;
  type Row = { id: string; asset_id: string; file_url: string; captured_at: string | null; uploaded_at: string | null };
  const rows: Row[] = [];
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await supabase
      .from("asset_photos")
      .select("id, asset_id, file_url, captured_at, uploaded_at")
      .in("asset_id", ids.slice(i, i + 150));
    if (error) throw new Error(error.message);
    rows.push(...(((data as Row[]) ?? [])));
  }
  // Newest first, so the no-designated-cover fallback picks the newest photo.
  rows.sort((a, b) =>
    String(b.captured_at ?? b.uploaded_at ?? "").localeCompare(String(a.captured_at ?? a.uploaded_at ?? "")));
  const coverId = new Map(assets.map((a) => [a.id, a.cover_photo_id ?? null]));
  for (const r of rows) {
    if (coverId.get(r.asset_id) === r.id) out.set(r.asset_id, r.file_url);
  }
  for (const r of rows) {
    if (!out.has(r.asset_id)) out.set(r.asset_id, r.file_url);
  }
  return out;
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

// ─── Linked files (drawings referenced by a tag) ─────────────────
// The "file reference" counterpart to photos: a tag links to OTHER documents.

/** Minimal document fields needed to label + resolve a linked drawing. */
export interface LinkedDocument {
  id: string;
  document_number: string | null;
  title: string | null;
  name: string | null;
  library_id: string | null;
  current_version_id: string | null;
  rev: string | null;
}

export interface AssetFile {
  id: string;
  org_id: string;
  asset_id: string;
  document_id: string;
  caption: string | null;
  sort_order: number;
  created_by: string;
  created_at: string;
  /** Joined document row (for label + PDF resolution). */
  document?: LinkedDocument | null;
}

export async function listAssetFiles(assetId: string): Promise<AssetFile[]> {
  const { data, error } = await supabase
    .from("asset_files")
    .select("*, document:documents(id, document_number, title, name, library_id, current_version_id, rev)")
    .eq("asset_id", assetId)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data as AssetFile[]) ?? [];
}

export async function getFileCounts(orgId: string, assetIds: string[]): Promise<Map<string, number>> {
  if (assetIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from("asset_files")
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

export async function linkAssetFile(input: {
  orgId: string;
  assetId: string;
  documentId: string;
  createdBy: string;
  caption?: string;
}): Promise<void> {
  const { error } = await supabase.from("asset_files").insert({
    org_id: input.orgId,
    asset_id: input.assetId,
    document_id: input.documentId,
    caption: input.caption ?? null,
    created_by: input.createdBy,
  });
  // A document already linked to this tag is fine — treat the duplicate as success.
  if (error && !/duplicate key|23505/.test(error.message)) throw new Error(error.message);
  invalidateAssetFileCache();
}

export async function unlinkAssetFile(id: string): Promise<void> {
  const { error } = await supabase.from("asset_files").delete().eq("id", id);
  if (error) throw new Error(error.message);
  invalidateAssetFileCache();
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
import { orIlike } from "@/lib/orFilter";

const photoCountCache = new Map<string, number>();
const fileCountCache = new Map<string, number>();         // assetId -> linked-file count
const lookupCache = new Map<string, Asset | null>();      // lookupKey -> asset
// Per-key subscriptions: resolving one tag re-renders only the chips bound to
// THAT tag, not every chip mounted on the page. The old global Set turned a
// tag-heavy folder's post-load settling into an O(n^2) re-render storm — each of
// n chips resolving notified all n chips.
const keySubscribers = new Map<string, Set<() => void>>();
function subscribeKey(key: string, fn: () => void): () => void {
  let set = keySubscribers.get(key);
  if (!set) { set = new Set(); keySubscribers.set(key, set); }
  set.add(fn);
  return () => {
    const s = keySubscribers.get(key);
    if (s) { s.delete(fn); if (s.size === 0) keySubscribers.delete(key); }
  };
}
function notifyKey(key: string) { keySubscribers.get(key)?.forEach((fn) => fn()); }
function notifyAllKeys() { keySubscribers.forEach((set) => set.forEach((fn) => fn())); }

/** The cache key for a label: its ID when it has one ("X-31 (2030.31)" and
 *  "2030.31" share one), else its tag in the unit. */
const lookupKey = (orgId: string, tag: string, unitCode?: string | null) => `${orgId}::${labelKey(tag, unitCode)}`;

export function useAssetByTag(orgId: string | null | undefined, tag: string, unitCode?: string | null): { asset: Asset | null; photoCount: number; loading: boolean } {
  const [, force] = useState(0);
  const [loading, setLoading] = useState(false);
  const key = orgId && tag ? lookupKey(orgId, tag, unitCode) : null;

  const reload = useCallback(() => force((x) => x + 1), []);

  useEffect(() => {
    if (!key) return;
    return subscribeKey(key, reload);
  }, [key, reload]);

  useEffect(() => {
    if (!key || !orgId || !tag) return;
    if (lookupCache.has(key)) return;     // already cached
    setLoading(true);
    let alive = true;
    (async () => {
      try {
        const a = await getAssetByTag(orgId, tag, unitCode);
        lookupCache.set(key, a);
        if (a) {
          const counts = await getPhotoCounts(orgId, [a.id]);
          photoCountCache.set(a.id, counts.get(a.id) || 0);
        }
      } catch {
        lookupCache.set(key, null);
      } finally {
        if (alive) { setLoading(false); if (key) notifyKey(key); }
      }
    })();
    return () => { alive = false; };
  }, [key, orgId, tag, unitCode]);

  const asset = key ? (lookupCache.get(key) ?? null) : null;
  const photoCount = asset ? (photoCountCache.get(asset.id) || 0) : 0;
  return { asset, photoCount, loading };
}

/** Like useAssetByTag, but resolves the count of LINKED DRAWINGS for a tag
 *  (for file-reference columns). Shares the asset lookup cache. */
export function useAssetFilesByTag(orgId: string | null | undefined, tag: string, unitCode?: string | null): { asset: Asset | null; fileCount: number; loading: boolean } {
  const [, force] = useState(0);
  const [loading, setLoading] = useState(false);
  const key = orgId && tag ? lookupKey(orgId, tag, unitCode) : null;

  const reload = useCallback(() => force((x) => x + 1), []);

  useEffect(() => {
    if (!key) return;
    return subscribeKey(key, reload);
  }, [key, reload]);

  useEffect(() => {
    if (!key || !orgId || !tag) return;
    const cached = lookupCache.get(key);
    if (cached === null) return;                                  // known: no asset
    if (cached && fileCountCache.has(cached.id)) return;          // already have count
    setLoading(true);
    let alive = true;
    (async () => {
      try {
        const a = cached ?? await getAssetByTag(orgId, tag, unitCode);
        lookupCache.set(key, a);
        if (a) {
          const counts = await getFileCounts(orgId, [a.id]);
          fileCountCache.set(a.id, counts.get(a.id) || 0);
        }
      } catch {
        lookupCache.set(key, null);
      } finally {
        if (alive) { setLoading(false); if (key) notifyKey(key); }
      }
    })();
    return () => { alive = false; };
  }, [key, orgId, tag, unitCode]);

  const asset = key ? (lookupCache.get(key) ?? null) : null;
  const fileCount = asset ? (fileCountCache.get(asset.id) || 0) : 0;
  return { asset, fileCount, loading };
}

/** Manually bust the cache (call after photo upload / asset create). */
export function invalidateAssetCache(): void {
  lookupCache.clear();
  photoCountCache.clear();
  fileCountCache.clear();
  notifyAllKeys();
}

/** Bust just the linked-file counts (call after link/unlink). */
export function invalidateAssetFileCache(): void {
  fileCountCache.clear();
  notifyAllKeys();
}
