"use client";

// /admin/assets — Tagged Asset Registry management.
//
// Stats strip at the top, search + type filter, grid of asset cards
// each with a cover photo or icon fallback. Click a card to open the
// detail drawer where you can edit metadata + manage photos.

import React, { useEffect, useState, useCallback, useMemo } from "react";
import {
  Tag, Plus, Search, Filter, Camera, Loader2,
  Image as ImageIcon, MapPin, Archive, AlertTriangle,
  Lock, X, Save, Edit3, Trash2, Settings, Layers,
  FileText,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import {
  listAssets, listAssetTypes, getPhotoCounts, createAsset,
  updateAsset, deleteAsset, listAssetPhotos, deletePhoto, updatePhoto,
  invalidateAssetCache, photoAgeCategory,
  type Asset, type AssetType, type AssetPhoto, type PhotoStatus,
} from "@/lib/assets";
import AssetPhotoCarousel from "@/components/assets/AssetPhotoCarousel";
import AssetPhotoUploader from "@/components/assets/AssetPhotoUploader";
import SignedImg from "@/components/assets/SignedImg";
import DuplicateAwareInput from "@/components/ui/DuplicateAwareInput";
import { translatePostgresError } from "@/lib/inputValidation";
import { normalizeTag } from "@/lib/assets";

const ADMIN_ROLES = ["Admin", "Manager", "Supervisor"];

export default function AssetsPage() {
  const { activeOrgId, activeRole, uid } = useRole();
  const isAdmin = ADMIN_ROLES.includes(activeRole);

  const [assets, setAssets] = useState<Asset[]>([]);
  const [types, setTypes] = useState<AssetType[]>([]);
  const [photoCounts, setPhotoCounts] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [filterMode, setFilterMode] = useState<"all" | "with_photos" | "no_photos">("all");

  const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null);
  const [creating, setCreating] = useState(false);
  const [carouselOpenFor, setCarouselOpenFor] = useState<Asset | null>(null);
  const [uploaderOpenFor, setUploaderOpenFor] = useState<Asset | null>(null);

  const refresh = useCallback(async () => {
    if (!activeOrgId) return;
    setLoading(true);
    setError(null);
    try {
      const [as, ts] = await Promise.all([
        listAssets({ orgId: activeOrgId, archived: false }),
        listAssetTypes(activeOrgId),
      ]);
      setAssets(as);
      setTypes(ts);
      const counts = await getPhotoCounts(activeOrgId, as.map((a) => a.id));
      setPhotoCounts(counts);
    } catch (e) {
      setError((e as Error).message);
    } finally { setLoading(false); }
  }, [activeOrgId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // ── Filters ────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return assets.filter((a) => {
      if (typeFilter && a.type_id !== typeFilter) return false;
      const count = photoCounts.get(a.id) || 0;
      if (filterMode === "with_photos" && count === 0) return false;
      if (filterMode === "no_photos" && count > 0) return false;
      if (q) {
        const haystack = `${a.tag} ${a.description ?? ""} ${a.location ?? ""}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [assets, photoCounts, typeFilter, filterMode, search]);

  // ── Stats ──────────────────────────────────────────────────
  const stats = useMemo(() => {
    const total = assets.length;
    let withPhotos = 0;
    let totalPhotos = 0;
    for (const a of assets) {
      const c = photoCounts.get(a.id) || 0;
      if (c > 0) withPhotos++;
      totalPhotos += c;
    }
    return { total, withPhotos, withoutPhotos: total - withPhotos, totalPhotos };
  }, [assets, photoCounts]);

  if (!activeOrgId) return null;

  return (
    <div className="min-h-screen bg-slate-50 p-8 pb-20">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-black text-slate-900 flex items-center gap-3">
              <Tag className="w-7 h-7 text-purple-600" />
              Asset Registry
            </h1>
            <p className="text-sm text-slate-600 mt-1 max-w-2xl">
              Canonical record for every piece of physical equipment, plus its photo gallery.
              Click any equipment tag anywhere in your library to see this asset&apos;s photos.
            </p>
          </div>
          {isAdmin && (
            <button
              onClick={() => setCreating(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-sm font-black shadow-lg shadow-purple-900/20"
            >
              <Plus className="w-4 h-4" /> New Asset
            </button>
          )}
        </div>

        {!isAdmin && (
          <div className="mb-6 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800 flex items-start gap-2">
            <Lock className="w-4 h-4 mt-0.5 shrink-0" />
            <span>Only Admin / Manager / Supervisor roles can create or edit assets. Your role: <b>{activeRole}</b>. You can still browse + view photos.</span>
          </div>
        )}

        {/* Stats strip */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <StatCard icon={<Layers className="w-5 h-5 text-purple-700" />} iconBg="bg-purple-100" value={stats.total} label="Total assets" tone="purple" />
          <StatCard icon={<Camera className="w-5 h-5 text-emerald-700" />} iconBg="bg-emerald-100" value={stats.totalPhotos} label="Photos in library" tone="emerald" />
          <StatCard icon={<ImageIcon className="w-5 h-5 text-blue-700" />} iconBg="bg-blue-100" value={stats.withPhotos} label="Assets with photos" tone="blue" />
          <StatCard icon={<AlertTriangle className="w-5 h-5 text-amber-700" />} iconBg="bg-amber-100" value={stats.withoutPhotos} label="Need photos" tone="amber" highlight={stats.withoutPhotos > 0} />
        </div>

        {/* Search + filters */}
        <div className="mb-4 flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by tag, description, or location…"
              className="w-full pl-10 pr-3 py-2.5 text-sm border border-slate-200 rounded-lg bg-white focus:ring-2 focus:ring-purple-500 focus:border-transparent outline-none"
            />
          </div>
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="px-3 py-2.5 text-sm border border-slate-200 rounded-lg bg-white font-medium">
            <option value="">All types</option>
            {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <div className="flex bg-white border border-slate-200 rounded-lg p-1">
            {(["all", "with_photos", "no_photos"] as const).map((m) => (
              <button key={m} onClick={() => setFilterMode(m)} className={`px-2.5 py-1.5 text-xs font-bold rounded-md ${filterMode === m ? "bg-slate-900 text-white" : "text-slate-600"}`}>
                {m === "all" ? "All" : m === "with_photos" ? "With photos" : "No photos"}
              </button>
            ))}
          </div>
        </div>

        {/* Grid */}
        {loading ? (
          <div className="text-center py-16 text-sm text-slate-500"><Loader2 className="w-5 h-5 animate-spin inline" /> Loading…</div>
        ) : error ? (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">{error}</div>
        ) : filtered.length === 0 ? (
          <EmptyState onCreate={isAdmin ? () => setCreating(true) : undefined} hasAny={assets.length > 0} />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {filtered.map((a) => {
              const type = types.find((t) => t.id === a.type_id);
              const count = photoCounts.get(a.id) || 0;
              return (
                <AssetCard
                  key={a.id}
                  asset={a}
                  type={type}
                  photoCount={count}
                  onClick={() => count > 0 ? setCarouselOpenFor(a) : setSelectedAsset(a)}
                  onEdit={isAdmin ? () => setSelectedAsset(a) : undefined}
                  onAddPhotos={isAdmin ? () => setUploaderOpenFor(a) : undefined}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* Modals */}
      {(creating || selectedAsset) && (
        <AssetEditDrawer
          asset={creating ? null : selectedAsset}
          orgId={activeOrgId}
          userId={uid || ""}
          types={types}
          canEdit={isAdmin}
          onClose={() => { setSelectedAsset(null); setCreating(false); }}
          onSaved={() => { void refresh(); }}
          onOpenCarousel={(a) => { setSelectedAsset(null); setCarouselOpenFor(a); }}
          onOpenUploader={(a) => { setSelectedAsset(null); setUploaderOpenFor(a); }}
        />
      )}

      {carouselOpenFor && (
        <AssetPhotoCarousel
          isOpen={!!carouselOpenFor}
          asset={carouselOpenFor}
          assetType={types.find((t) => t.id === carouselOpenFor.type_id)}
          canManage={isAdmin}
          onClose={() => setCarouselOpenFor(null)}
          onUploadClick={() => { const a = carouselOpenFor; setCarouselOpenFor(null); setUploaderOpenFor(a); }}
          onEditAsset={() => { const a = carouselOpenFor; setCarouselOpenFor(null); setSelectedAsset(a); }}
        />
      )}

      {uploaderOpenFor && uid && (
        <AssetPhotoUploader
          isOpen={!!uploaderOpenFor}
          asset={uploaderOpenFor}
          userId={uid}
          onClose={() => setUploaderOpenFor(null)}
          onUploaded={() => { void refresh(); }}
        />
      )}
    </div>
  );
}

// ─── Stat card ─────────────────────────────────────────────

function StatCard({
  icon, iconBg, value, label, tone, highlight,
}: {
  icon: React.ReactNode; iconBg: string; value: number; label: string;
  tone: "purple" | "emerald" | "blue" | "amber"; highlight?: boolean;
}) {
  const ring = highlight
    ? (tone === "amber" ? "ring-2 ring-amber-200" : "ring-2 ring-emerald-200")
    : "";
  return (
    <div className={`bg-white rounded-2xl border border-slate-200 shadow-sm p-4 flex items-center gap-3 ${ring}`}>
      <div className={`p-2.5 rounded-xl ${iconBg}`}>{icon}</div>
      <div>
        <div className="text-2xl font-black text-slate-900 leading-none">{value.toLocaleString()}</div>
        <div className="text-[11px] text-slate-500 mt-1">{label}</div>
      </div>
    </div>
  );
}

// ─── Asset card ────────────────────────────────────────────

function AssetCard({
  asset, type, photoCount, onClick, onEdit, onAddPhotos,
}: {
  asset: Asset; type?: AssetType; photoCount: number;
  onClick: () => void; onEdit?: () => void; onAddPhotos?: () => void;
}) {
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!asset.cover_photo_id && photoCount === 0) return;
    // Fetch the cover photo URL (or first photo if no cover set)
    listAssetPhotos(asset.id).then((photos) => {
      if (photos.length > 0) {
        const cover = photos.find((p) => p.id === asset.cover_photo_id) || photos[0];
        setCoverUrl(cover.file_url);
      }
    }).catch(() => {});
  }, [asset.id, asset.cover_photo_id, photoCount]);

  return (
    <div className="group bg-white rounded-2xl border border-slate-200 shadow-sm hover:shadow-lg hover:border-slate-300 transition-all overflow-hidden flex flex-col">
      {/* Cover area */}
      <button onClick={onClick} className="block aspect-[4/3] w-full relative bg-gradient-to-br from-slate-100 to-slate-200 overflow-hidden">
        {coverUrl ? (
          <>
            <SignedImg path={coverUrl} alt={asset.tag} className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
            {photoCount > 1 && (
              <div className="absolute top-2 right-2 inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-black/60 backdrop-blur-sm text-white text-[10px] font-bold">
                <Camera className="w-3 h-3" /> {photoCount}
              </div>
            )}
          </>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="p-5 rounded-2xl bg-white/60 backdrop-blur border border-white">
              <ImageIcon className="w-8 h-8 text-slate-400" />
            </div>
          </div>
        )}
      </button>
      {/* Info */}
      <div className="p-3 flex-1 flex flex-col">
        <div className="flex items-center gap-2 mb-1">
          <button onClick={onClick} className="text-sm font-black text-slate-900 hover:text-purple-700 truncate flex-1 text-left">
            {asset.tag}
          </button>
          {type && (
            <span className="text-[9px] font-black uppercase tracking-widest bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded shrink-0">
              {type.name}
            </span>
          )}
        </div>
        {asset.description && (
          <div className="text-[11px] text-slate-500 line-clamp-2 mb-1">{asset.description}</div>
        )}
        {asset.location && (
          <div className="text-[10px] text-slate-400 flex items-center gap-1 truncate">
            <MapPin className="w-3 h-3" /> {asset.location}
          </div>
        )}
        <div className="mt-2 pt-2 border-t border-slate-100 flex items-center justify-between">
          <div className="text-[10px] font-bold text-slate-500">
            {photoCount === 0 ? (
              <span className="text-amber-700 inline-flex items-center gap-1"><AlertTriangle className="w-2.5 h-2.5" /> No photos</span>
            ) : (
              <span className="inline-flex items-center gap-1 text-blue-700"><Camera className="w-2.5 h-2.5" /> {photoCount} photo{photoCount === 1 ? "" : "s"}</span>
            )}
          </div>
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {onAddPhotos && (
              <button onClick={onAddPhotos} title="Add photos" className="p-1 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 rounded">
                <Camera className="w-3.5 h-3.5" />
              </button>
            )}
            {onEdit && (
              <button onClick={onEdit} title="Edit asset" className="p-1 text-slate-400 hover:text-purple-700 hover:bg-purple-50 rounded">
                <Edit3 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Empty state ────────────────────────────────────────────

function EmptyState({ onCreate, hasAny }: { onCreate?: () => void; hasAny: boolean }) {
  return (
    <div className="bg-white border border-dashed border-slate-300 rounded-2xl p-12 text-center">
      <div className="p-5 rounded-2xl bg-purple-50 w-fit mx-auto mb-4 border border-purple-100">
        <Tag className="w-10 h-10 text-purple-500" />
      </div>
      <h3 className="text-base font-black text-slate-900 mb-1">
        {hasAny ? "No matches" : "No assets yet"}
      </h3>
      <p className="text-sm text-slate-600 max-w-md mx-auto mb-4">
        {hasAny
          ? "Try a different search or clear the filters."
          : "Create your first asset — equipment, instrument, valve, anything taggable. Once an asset exists, its tag becomes a clickable chip everywhere you reference it."}
      </p>
      {!hasAny && onCreate && (
        <button onClick={onCreate} className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-sm font-black shadow-lg">
          <Plus className="w-4 h-4" /> Create first asset
        </button>
      )}
    </div>
  );
}

// ─── Edit / Create drawer ──────────────────────────────────

function AssetEditDrawer({
  asset, orgId, userId, types, canEdit,
  onClose, onSaved, onOpenCarousel, onOpenUploader,
}: {
  asset: Asset | null;
  orgId: string;
  userId: string;
  types: AssetType[];
  canEdit: boolean;
  onClose: () => void;
  onSaved: () => void;
  onOpenCarousel: (a: Asset) => void;
  onOpenUploader: (a: Asset) => void;
}) {
  const isCreate = !asset;
  const [tag, setTag] = useState(asset?.tag ?? "");
  const [typeId, setTypeId] = useState(asset?.type_id ?? "");
  const [description, setDescription] = useState(asset?.description ?? "");
  const [location, setLocation] = useState(asset?.location ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasTagConflict, setHasTagConflict] = useState(false);
  const [photos, setPhotos] = useState<AssetPhoto[]>([]);

  useEffect(() => {
    if (!asset) return;
    listAssetPhotos(asset.id).then(setPhotos).catch(() => {});
  }, [asset]);

  const save = async () => {
    if (!tag.trim()) { setError("Tag required"); return; }
    setBusy(true); setError(null);
    try {
      if (isCreate) {
        const created = await createAsset({
          orgId, tag: tag.trim(),
          typeId: typeId || undefined,
          description: description.trim() || undefined,
          location: location.trim() || undefined,
          createdBy: userId,
        });
        invalidateAssetCache();
        onSaved();
        // Stay open so user can immediately upload photos
        // Replace `asset` in url? Simplification: just close.
        onOpenUploader(created);
      } else {
        await updateAsset(asset!.id, {
          tag: tag.trim(),
          type_id: typeId || null,
          description: description.trim() || null,
          location: location.trim() || null,
        }, userId);
        invalidateAssetCache();
        onSaved();
        onClose();
      }
    } catch (e) {
      const friendly = translatePostgresError(e, { entity: "asset", field: "tag" });
      setError(`${friendly.heading} — ${friendly.message}`);
    }
    finally { setBusy(false); }
  };

  const onDelete = async () => {
    if (!asset) return;
    if (!confirm(`Delete asset "${asset.tag}" and all its photos? This can't be undone.`)) return;
    setBusy(true);
    try {
      await deleteAsset(asset.id);
      invalidateAssetCache();
      onSaved();
      onClose();
    } catch (e) {
      const f = translatePostgresError(e, { entity: "asset" });
      setError(`${f.heading} — ${f.message}`);
      setBusy(false);
    }
  };

  const markPhotoStatus = async (p: AssetPhoto, status: PhotoStatus) => {
    try {
      await updatePhoto(p.id, { status }, userId);
      setPhotos((prev) => prev.map((x) => x.id === p.id ? { ...x, status } : x));
    } catch (e) { alert((e as Error).message); }
  };

  const onDeletePhoto = async (p: AssetPhoto) => {
    if (!confirm("Remove this photo?")) return;
    try {
      await deletePhoto(p.id);
      setPhotos((prev) => prev.filter((x) => x.id !== p.id));
    } catch (e) { alert((e as Error).message); }
  };

  return (
    <div className="fixed inset-0 z-[400] flex" onClick={onClose}>
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" />
      <div onClick={(e) => e.stopPropagation()} className="relative ml-auto w-full max-w-xl bg-white shadow-2xl border-l border-slate-200 flex flex-col h-screen">
        <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 bg-purple-100 rounded-lg"><Tag className="w-4 h-4 text-purple-700" /></div>
            <div>
              <div className="text-sm font-black text-slate-900">
                {isCreate ? "Create asset" : `Edit ${asset?.tag}`}
              </div>
              <div className="text-[11px] text-slate-500">Canonical record + photo gallery</div>
            </div>
          </div>
          <button onClick={onClose} disabled={busy} className="p-1.5 rounded text-slate-400 hover:text-slate-900 hover:bg-slate-100">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-5 space-y-5">
          {/* Form */}
          <div className="space-y-3">
            <div>
              <label className="text-[10px] font-black text-slate-700 uppercase tracking-widest">Tag *</label>
              <DuplicateAwareInput
                value={tag}
                onChange={setTag}
                onDuplicateChange={(isDup) => setHasTagConflict(isDup)}
                check={{
                  table: "assets",
                  column: "tag_normalized",
                  scope: { org_id: orgId },
                  normalize: normalizeTag,
                  excludeId: asset?.id,
                }}
                fieldLabel="asset tag"
                disabled={!canEdit || busy}
                placeholder="e.g. FE-201"
                className="font-mono mt-1"
              />
              {tag && (
                <div className="text-[10px] text-slate-500 mt-1">Normalized: <span className="font-mono">{normalizeTag(tag)}</span></div>
              )}
            </div>
            <div>
              <label className="text-[10px] font-black text-slate-700 uppercase tracking-widest">Type</label>
              <select value={typeId} onChange={(e) => setTypeId(e.target.value)} disabled={!canEdit || busy} className="mt-1 w-full px-3 py-2 border border-slate-300 rounded-lg text-sm">
                <option value="">— Untyped —</option>
                {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[10px] font-black text-slate-700 uppercase tracking-widest">Description</label>
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} disabled={!canEdit || busy} rows={2} placeholder="What this thing is" className="mt-1 w-full px-3 py-2 border border-slate-300 rounded-lg text-sm resize-y" />
            </div>
            <div>
              <label className="text-[10px] font-black text-slate-700 uppercase tracking-widest">Location</label>
              <input value={location} onChange={(e) => setLocation(e.target.value)} disabled={!canEdit || busy} placeholder="e.g. Unit 200 cold side" className="mt-1 w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" />
            </div>
          </div>

          {/* Photos section (edit mode only) */}
          {!isCreate && asset && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="text-[10px] font-black text-slate-700 uppercase tracking-widest">
                  Photos ({photos.length})
                </div>
                <div className="flex items-center gap-1.5">
                  {photos.length > 0 && (
                    <button onClick={() => onOpenCarousel(asset)} className="inline-flex items-center gap-1 text-[11px] font-bold text-blue-700 hover:text-blue-800">
                      <ImageIcon className="w-3 h-3" /> Open carousel
                    </button>
                  )}
                  {canEdit && (
                    <button onClick={() => onOpenUploader(asset)} className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700 hover:text-emerald-800">
                      <Camera className="w-3 h-3" /> Add photos
                    </button>
                  )}
                </div>
              </div>
              {photos.length === 0 ? (
                <div className="text-center text-xs text-slate-400 italic py-6 border border-dashed border-slate-200 rounded-lg">
                  No photos yet.
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-2">
                  {photos.map((p) => {
                    const age = photoAgeCategory(p.captured_at);
                    return (
                      <div key={p.id} className="relative group rounded-lg overflow-hidden border border-slate-200 aspect-square bg-slate-100">
                        <SignedImg path={p.file_url} alt={p.caption || ""} className="w-full h-full object-cover" />
                        <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/80 to-transparent p-1.5">
                          <div className="text-[9px] text-white font-mono flex items-center gap-1">
                            <span className={`w-1.5 h-1.5 rounded-full ${
                              age.category === "fresh" ? "bg-emerald-400" :
                              age.category === "aging" ? "bg-amber-400" :
                              age.category === "stale" ? "bg-red-400" : "bg-slate-400"
                            }`} />
                            {p.captured_at ? new Date(p.captured_at).toLocaleDateString() : "no date"}
                          </div>
                        </div>
                        {p.status !== "current" && (
                          <div className={`absolute top-1 left-1 text-[8px] font-black uppercase px-1 py-0.5 rounded ${
                            p.status === "needs_verification" ? "bg-amber-500 text-white" : "bg-red-500 text-white"
                          }`}>
                            {p.status === "needs_verification" ? "Verify" : "Old"}
                          </div>
                        )}
                        {canEdit && (
                          <div className="absolute top-1 right-1 flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button onClick={() => markPhotoStatus(p, p.status === "current" ? "needs_verification" : "current")} title="Toggle verification" className="p-1 bg-white/90 rounded hover:bg-white">
                              <AlertTriangle className="w-3 h-3 text-amber-600" />
                            </button>
                            <button onClick={() => onDeletePhoto(p)} title="Delete photo" className="p-1 bg-white/90 rounded hover:bg-white">
                              <Trash2 className="w-3 h-3 text-red-600" />
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700 flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {error}
            </div>
          )}
        </div>

        <div className="px-5 py-3 bg-slate-50 border-t border-slate-200 flex items-center justify-between shrink-0">
          {!isCreate && canEdit ? (
            <button onClick={onDelete} disabled={busy} className="text-xs font-bold text-red-600 hover:text-red-700 inline-flex items-center gap-1">
              <Trash2 className="w-3 h-3" /> Delete asset
            </button>
          ) : <div />}
          <div className="flex items-center gap-2">
            <button onClick={onClose} disabled={busy} className="px-3 py-2 rounded-lg text-xs font-bold text-slate-700 bg-white border border-slate-200">Cancel</button>
            {canEdit && (
              <button onClick={save} disabled={busy || !tag.trim() || hasTagConflict} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-black text-white bg-purple-600 hover:bg-purple-500 disabled:opacity-50 shadow">
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                {isCreate ? "Create & add photos" : "Save"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
