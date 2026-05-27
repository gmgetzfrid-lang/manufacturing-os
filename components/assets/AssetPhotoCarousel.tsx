"use client";

// AssetPhotoCarousel — full-screen photo viewer for a single asset.
//
// Open by clicking an AssetTagChip with photos, or directly from the
// asset detail drawer. Apple-style dark backdrop blur, keyboard nav,
// thumbnail strip, age-coded date watermark on each photo.

import React, { useEffect, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  X, ChevronLeft, ChevronRight, Camera, Calendar, AlertTriangle,
  Loader2, Tag, MapPin, FileText, Upload, Image as ImageIcon,
  CheckCircle2, EyeOff, Edit3,
} from "lucide-react";
import {
  listAssetPhotos, photoAgeCategory, type Asset, type AssetPhoto,
  type AssetType,
} from "@/lib/assets";
import SignedImg from "./SignedImg";

interface AssetPhotoCarouselProps {
  isOpen: boolean;
  asset: Asset;
  assetType?: AssetType | null;
  canManage?: boolean;
  onClose: () => void;
  onUploadClick?: () => void;
  onEditAsset?: () => void;
}

export default function AssetPhotoCarousel({
  isOpen, asset, assetType, canManage = false,
  onClose, onUploadClick, onEditAsset,
}: AssetPhotoCarouselProps) {
  const [photos, setPhotos] = useState<AssetPhoto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [imageLoaded, setImageLoaded] = useState(false);

  // Load photos on open
  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    setError(null);
    setActiveIdx(0);
    setImageLoaded(false);
    listAssetPhotos(asset.id)
      .then(setPhotos)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [isOpen, asset.id]);

  const next = useCallback(() => {
    setImageLoaded(false);
    setActiveIdx((i) => (photos.length === 0 ? 0 : (i + 1) % photos.length));
  }, [photos.length]);
  const prev = useCallback(() => {
    setImageLoaded(false);
    setActiveIdx((i) => (photos.length === 0 ? 0 : (i - 1 + photos.length) % photos.length));
  }, [photos.length]);

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") prev();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose, next, prev]);

  if (!isOpen) return null;
  const active = photos[activeIdx];
  const age = active ? photoAgeCategory(active.captured_at) : null;

  // Portal so the full-screen overlay escapes any transformed ancestor
  // (e.g. the InspectorDrawer) and reliably covers the entire viewport.
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[500] bg-slate-950/95 backdrop-blur-md flex flex-col"
      onClick={onClose}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Top bar with asset info + close */}
      <div className="shrink-0 px-6 py-4 flex items-center justify-between border-b border-white/10" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 min-w-0">
          <div className="p-2 rounded-xl bg-white/10 backdrop-blur shrink-0">
            <Tag className="w-4 h-4 text-white" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-base font-black text-white truncate">{asset.tag}</span>
              {assetType && (
                <span className="text-[10px] font-black uppercase tracking-widest bg-white/15 text-white/90 px-1.5 py-0.5 rounded">
                  {assetType.name}
                </span>
              )}
              {photos.length > 0 && (
                <span className="text-[11px] font-mono text-white/60">
                  {activeIdx + 1} / {photos.length}
                </span>
              )}
            </div>
            <div className="text-[11px] text-slate-300 truncate flex items-center gap-3">
              {asset.description && <span className="truncate max-w-md">{asset.description}</span>}
              {asset.location && (
                <span className="inline-flex items-center gap-1 shrink-0">
                  <MapPin className="w-3 h-3" /> {asset.location}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {canManage && onEditAsset && (
            <button onClick={onEditAsset} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-white text-xs font-bold backdrop-blur transition-colors">
              <Edit3 className="w-3.5 h-3.5" /> Edit asset
            </button>
          )}
          {canManage && onUploadClick && (
            <button onClick={onUploadClick} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow-lg transition-colors">
              <Upload className="w-3.5 h-3.5" /> Add photos
            </button>
          )}
          <button onClick={onClose} title="Close (Esc)" className="p-2 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Center: hero photo */}
      <div className="flex-1 relative flex items-center justify-center overflow-hidden" onClick={(e) => e.stopPropagation()}>
        {loading && (
          <div className="text-white/60 flex flex-col items-center gap-3">
            <Loader2 className="w-8 h-8 animate-spin" />
            <span className="text-xs">Loading photos…</span>
          </div>
        )}
        {error && (
          <div className="text-red-300 flex items-center gap-2 px-4 py-2 bg-red-500/10 rounded-lg">
            <AlertTriangle className="w-4 h-4" /> {error}
          </div>
        )}
        {!loading && !error && photos.length === 0 && (
          <EmptyState canUpload={canManage} onUpload={onUploadClick} />
        )}

        {!loading && photos.length > 0 && active && (
          <>
            {/* Prev / Next arrows */}
            {photos.length > 1 && (
              <>
                <button
                  onClick={prev}
                  className="absolute left-4 top-1/2 -translate-y-1/2 z-10 p-3 rounded-full bg-white/10 hover:bg-white/20 text-white backdrop-blur transition-all hover:scale-105"
                  title="Previous (←)"
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
                <button
                  onClick={next}
                  className="absolute right-4 top-1/2 -translate-y-1/2 z-10 p-3 rounded-full bg-white/10 hover:bg-white/20 text-white backdrop-blur transition-all hover:scale-105"
                  title="Next (→)"
                >
                  <ChevronRight className="w-5 h-5" />
                </button>
              </>
            )}

            {/* Hero image */}
            <div className="relative max-w-[90%] max-h-full flex items-center justify-center">
              {!imageLoaded && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <Loader2 className="w-6 h-6 animate-spin text-white/40" />
                </div>
              )}
              <SignedImg
                path={active.file_url}
                alt={active.caption || `${asset.tag} photo`}
                onLoad={() => setImageLoaded(true)}
                className={`max-w-full max-h-[calc(100vh-280px)] object-contain rounded-xl shadow-2xl transition-opacity duration-300 ${imageLoaded ? "opacity-100" : "opacity-0"}`}
              />

              {/* Date watermark overlay */}
              {age && (
                <div className="absolute bottom-3 right-3 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-950/70 backdrop-blur-sm text-white text-[11px] font-mono shadow-lg">
                  <Calendar className="w-3 h-3" />
                  {active.captured_at ? new Date(active.captured_at).toLocaleDateString() : "date unknown"}
                  <span className={`w-1.5 h-1.5 rounded-full ${
                    age.category === "fresh" ? "bg-emerald-400" :
                    age.category === "aging" ? "bg-amber-400" :
                    age.category === "stale" ? "bg-red-400" :
                    "bg-slate-400"
                  }`} />
                  <span className="opacity-70">· {age.label}</span>
                </div>
              )}

              {/* Status badge if not 'current' */}
              {active.status !== "current" && (
                <div className={`absolute top-3 left-3 flex items-center gap-1 px-2.5 py-1 rounded-lg backdrop-blur-sm text-white text-[11px] font-black uppercase tracking-wide shadow-lg ${
                  active.status === "needs_verification"
                    ? "bg-amber-500/90"
                    : "bg-red-500/90"
                }`}>
                  {active.status === "needs_verification" ? <AlertTriangle className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                  {active.status === "needs_verification" ? "Needs Verification" : "Superseded"}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Caption */}
      {active?.caption && (
        <div className="shrink-0 px-6 py-3 text-center text-sm text-white/80 max-w-3xl mx-auto" onClick={(e) => e.stopPropagation()}>
          {active.caption}
        </div>
      )}

      {/* Thumbnail strip */}
      {photos.length > 1 && (
        <div className="shrink-0 px-6 py-3 border-t border-white/10" onClick={(e) => e.stopPropagation()}>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {photos.map((p, i) => {
              const pAge = photoAgeCategory(p.captured_at);
              return (
                <button
                  key={p.id}
                  onClick={() => { setActiveIdx(i); setImageLoaded(false); }}
                  className={`shrink-0 w-20 h-20 rounded-lg overflow-hidden border-2 transition-all relative group ${
                    i === activeIdx ? "border-white ring-2 ring-white/40" : "border-white/20 hover:border-white/50 opacity-70 hover:opacity-100"
                  }`}
                >
                  <SignedImg path={p.file_url} alt="" className="w-full h-full object-cover" />
                  <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-1 py-0.5 flex items-center justify-between">
                    <span className={`w-1.5 h-1.5 rounded-full ${
                      pAge.category === "fresh" ? "bg-emerald-400" :
                      pAge.category === "aging" ? "bg-amber-400" :
                      pAge.category === "stale" ? "bg-red-400" :
                      "bg-slate-400"
                    }`} />
                    {p.status !== "current" && (
                      <span className="text-[8px] font-black uppercase text-white">
                        {p.status === "needs_verification" ? "Verify" : "Old"}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>,
    document.body
  );
}

function EmptyState({ canUpload, onUpload }: { canUpload: boolean; onUpload?: () => void }) {
  return (
    <div className="flex flex-col items-center text-center text-white/70 max-w-md">
      <div className="p-6 rounded-3xl bg-white/5 backdrop-blur mb-4">
        <ImageIcon className="w-16 h-16 text-white/40" />
      </div>
      <h3 className="text-base font-black text-white mb-1">No photos yet</h3>
      <p className="text-xs text-white/60 leading-relaxed mb-4">
        Once photos are uploaded for this asset they&apos;ll appear here. Field workers, engineers, and
        operators all see the same gallery — wherever this tag appears in your library.
      </p>
      {canUpload && onUpload && (
        <button
          onClick={onUpload}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-black shadow-lg shadow-emerald-900/30"
        >
          <Upload className="w-4 h-4" /> Upload first photo
        </button>
      )}
    </div>
  );
}
