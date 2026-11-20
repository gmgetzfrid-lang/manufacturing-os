"use client";

// AssetPhotoPopover — small floating photo viewer that opens next to
// the clicked equipment tag chip. Lets users glance at photos without
// losing context of the P&ID / inspector / viewer they're already
// looking at. Has an "expand" button to escalate to the full-screen
// carousel when they want a longer look.
//
// Positioning rules:
//   - Default: anchored below the tag, centered horizontally on it
//   - If it would overflow the viewport bottom, flip above the tag
//   - If it would overflow horizontally, clamp to the viewport
//   - Closes on Escape, outside click, or explicit Close button

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  X, ChevronLeft, ChevronRight, Camera, Calendar,
  Loader2, Upload, Tag, MapPin,
} from "lucide-react";
import {
  listAssetPhotos, photoAgeCategory, type Asset, type AssetPhoto,
  type AssetType,
} from "@/lib/assets";
import SignedImg from "./SignedImg";

interface AssetPhotoPopoverProps {
  asset: Asset;
  assetType?: AssetType | null;
  anchorEl: HTMLElement | null;
  canManage?: boolean;
  onClose: () => void;
  onExpandFull: () => void;
  onUploadClick?: () => void;
}

const POPOVER_WIDTH = 384;
const POPOVER_HEIGHT_ESTIMATE = 380;

export default function AssetPhotoPopover({
  asset, assetType, anchorEl, canManage = false,
  onClose, onExpandFull, onUploadClick,
}: AssetPhotoPopoverProps) {
  const [position, setPosition] = useState<{ top: number; left: number; placement: "below" | "above" }>({
    top: -9999, left: -9999, placement: "below",
  });
  const [photos, setPhotos] = useState<AssetPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const popoverRef = useRef<HTMLDivElement>(null);

  // ── Position relative to the anchor element ─────────────────────
  // Measuring the anchor and committing the result is the legitimate use of a
  // layout effect; the IIFE keeps the (synchronous, pre-paint) setState out of
  // the effect's direct body so it isn't read as a cascading update.
  useLayoutEffect(() => {
    const el = anchorEl;
    if (!el) return;
    void (async () => {
      const rect = el.getBoundingClientRect();
      const pad = 8;
      let placement: "below" | "above" = "below";

      let top = rect.bottom + pad;
      if (top + POPOVER_HEIGHT_ESTIMATE > window.innerHeight - pad) {
        top = rect.top - POPOVER_HEIGHT_ESTIMATE - pad;
        placement = "above";
        if (top < pad) top = pad;
      }
      let left = rect.left + rect.width / 2 - POPOVER_WIDTH / 2;
      if (left < pad) left = pad;
      if (left + POPOVER_WIDTH > window.innerWidth - pad) {
        left = window.innerWidth - POPOVER_WIDTH - pad;
      }

      setPosition({ top, left, placement });
    })();
  }, [anchorEl]);

  // Re-position on scroll / resize
  useEffect(() => {
    const reposition = () => {
      if (!anchorEl) return;
      const rect = anchorEl.getBoundingClientRect();
      // If the anchor scrolled out of view entirely, close
      if (rect.bottom < 0 || rect.top > window.innerHeight) {
        onClose();
        return;
      }
      const pad = 8;
      let placement: "below" | "above" = "below";
      let top = rect.bottom + pad;
      if (top + POPOVER_HEIGHT_ESTIMATE > window.innerHeight - pad) {
        top = rect.top - POPOVER_HEIGHT_ESTIMATE - pad;
        placement = "above";
        if (top < pad) top = pad;
      }
      let left = rect.left + rect.width / 2 - POPOVER_WIDTH / 2;
      if (left < pad) left = pad;
      if (left + POPOVER_WIDTH > window.innerWidth - pad) {
        left = window.innerWidth - POPOVER_WIDTH - pad;
      }
      setPosition({ top, left, placement });
    };
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [anchorEl, onClose]);

  // ── Load photos ─────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    void (async () => {
      setLoading(true);
      setLoadFailed(false);
      setActiveIdx(0);
      try {
        const ph = await listAssetPhotos(asset.id);
        if (alive) setPhotos(ph);
      } catch {
        if (alive) { setPhotos([]); setLoadFailed(true); }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [asset.id]);

  // ── Keyboard nav + outside-click ────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      else if (e.key === "ArrowRight") setActiveIdx((i) => (photos.length === 0 ? 0 : (i + 1) % photos.length));
      else if (e.key === "ArrowLeft") setActiveIdx((i) => (photos.length === 0 ? 0 : (i - 1 + photos.length) % photos.length));
    };
    const onClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node) && anchorEl && !anchorEl.contains(e.target as Node)) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClickOutside);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClickOutside);
    };
  }, [onClose, anchorEl, photos.length]);

  const active = photos[activeIdx];
  const age = active ? photoAgeCategory(active.captured_at) : null;

  // Render through a portal to document.body so the popover escapes
  // any transformed ancestor (e.g. the InspectorDrawer's slide-in
  // transform). Without the portal, fixed-position children of a
  // transformed element are positioned relative to that element,
  // which throws the popover off-screen and overlays unrelated UI.
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      style={{ top: position.top, left: position.left, width: POPOVER_WIDTH }}
      className="fixed z-[400] bg-[var(--color-surface)] text-[var(--color-text)] rounded-xl shadow-lg border border-[var(--color-border)] ring-1 ring-black/5 overflow-hidden animate-in fade-in zoom-in-95 duration-150"
    >
      {/* Tail / pointer */}
      {anchorEl && (
        <div
          className={`absolute w-3 h-3 bg-[var(--color-surface)] border border-[var(--color-border)] rotate-45 ${position.placement === "below" ? "-top-1.5 border-r-0 border-b-0" : "-bottom-1.5 border-l-0 border-t-0"}`}
          style={{
            left: Math.max(12, Math.min(POPOVER_WIDTH - 18, anchorEl.getBoundingClientRect().left + anchorEl.getBoundingClientRect().width / 2 - position.left - 6)),
          }}
        />
      )}

      {/* Header */}
      <div className="px-3 py-2 border-b border-[var(--color-border)] flex items-center gap-2">
        <div className="p-1 bg-[var(--color-surface-2)] rounded shrink-0">
          <Tag className="w-3 h-3 text-[var(--color-text-muted)]" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-black text-[var(--color-text)] truncate">{asset.tag}</span>
            {assetType && (
              <span className="text-[11px] font-black uppercase tracking-widest bg-[var(--color-surface-2)] text-[var(--color-text-muted)] px-1.5 py-0.5 rounded">
                {assetType.name}
              </span>
            )}
          </div>
          {(asset.description || asset.location) && (
            <div className="text-[11px] text-[var(--color-text-muted)] truncate flex items-center gap-1.5">
              {asset.description && <span className="truncate">{asset.description}</span>}
              {asset.location && (
                <span className="inline-flex items-center gap-0.5 shrink-0">
                  <MapPin className="w-2.5 h-2.5" /> {asset.location}
                </span>
              )}
            </div>
          )}
        </div>
        <button
          onClick={onClose}
          title="Close (Esc)"
          aria-label="Close"
          className="p-1.5 rounded-md text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] shrink-0"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Main photo area */}
      <div className="relative bg-[var(--color-surface-2)] aspect-[4/3] flex items-center justify-center">
        {loading ? (
          <div className="text-[var(--color-text-faint)] flex items-center gap-2 text-xs">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading photos…
          </div>
        ) : loadFailed ? (
          <div role="alert" className="text-xs text-rose-700 dark:text-rose-400 p-3 text-center">Couldn&apos;t load the photos. Close and open the tag again.</div>
        ) : photos.length === 0 ? (
          <EmptyState canUpload={canManage && !!onUploadClick} onUpload={onUploadClick} />
        ) : (
          <>
            <SignedImg
              path={active.file_url}
              alt={active.caption || `${asset.tag} photo`}
              className="max-w-full max-h-full object-contain"
            />
            {photos.length > 1 && (
              <>
                <button
                  onClick={() => setActiveIdx((i) => (i - 1 + photos.length) % photos.length)}
                  className="absolute left-1.5 top-1/2 -translate-y-1/2 p-1.5 rounded-full bg-[var(--color-surface)]/90 hover:bg-[var(--color-surface)] shadow text-[var(--color-text)]"
                  title="Previous"
                  aria-label="Previous photo"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => setActiveIdx((i) => (i + 1) % photos.length)}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1.5 rounded-full bg-[var(--color-surface)]/90 hover:bg-[var(--color-surface)] shadow text-[var(--color-text)]"
                  title="Next"
                  aria-label="Next photo"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </>
            )}
          </>
        )}
      </div>

      {/* Date, age and status: a plain line under the photo, not a badge on it. */}
      {active && age && (
        <div className="px-3 py-1.5 border-t border-[var(--color-border)] flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
          <Calendar className="w-3 h-3 shrink-0" />
          <span className="font-mono">{active.captured_at ? new Date(active.captured_at).toLocaleDateString() : "No date"}</span>
          {age.category !== "unknown" && (
            <span className={age.category === "stale" ? "text-red-700 dark:text-red-400 font-bold" : age.category === "aging" ? "text-amber-700 dark:text-amber-400 font-bold" : ""}>· {age.label}</span>
          )}
          {active.status !== "current" && (
            <span className={`ml-auto font-bold ${active.status === "needs_verification" ? "text-amber-700 dark:text-amber-400" : "text-red-700 dark:text-red-400"}`}>
              {active.status === "needs_verification" ? "Needs checking" : "Out of date"}
            </span>
          )}
        </div>
      )}

      {/* Caption */}
      {active?.caption && (
        <div className="px-3 py-2 text-[11px] text-[var(--color-text)] border-t border-[var(--color-border)] leading-snug">
          {active.caption}
        </div>
      )}

      {/* Thumbnail strip */}
      {photos.length > 1 && (
        <div className="px-2 py-2 border-t border-[var(--color-border)] flex gap-1 overflow-x-auto">
          {photos.map((p, i) => (
            <button
              key={p.id}
              onClick={() => setActiveIdx(i)}
              aria-label={`Photo ${i + 1}`}
              aria-current={i === activeIdx ? "true" : undefined}
              className={`shrink-0 w-12 h-12 rounded overflow-hidden border-2 transition-all relative ${
                i === activeIdx ? "border-[var(--color-text)]" : "border-[var(--color-border)] opacity-70 hover:opacity-100"
              }`}
            >
              <SignedImg path={p.file_url} alt="" className="w-full h-full object-cover" />
            </button>
          ))}
        </div>
      )}

      {/* Footer action */}
      <div className="px-3 py-2 bg-[var(--color-surface-2)] border-t border-[var(--color-border)] flex items-center justify-between gap-2">
        <span className="text-[11px] text-[var(--color-text-muted)]">
          {photos.length > 0 ? `${activeIdx + 1} of ${photos.length}` : "No photos"}
          {photos.length > 0 && <> · <button onClick={onExpandFull} className="font-bold text-[var(--color-accent)] hover:underline">Open full view</button></>}
        </span>
        {canManage && onUploadClick && photos.length > 0 && (
          <button
            onClick={onUploadClick}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-bold border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
          >
            <Upload className="w-3 h-3" /> Add photos
          </button>
        )}
      </div>
    </div>,
    document.body
  );
}

function EmptyState({ canUpload, onUpload }: { canUpload: boolean; onUpload?: () => void }) {
  return (
    <div className="flex flex-col items-center text-center text-[var(--color-text-muted)] p-3">
      <Camera className="w-8 h-8 text-[var(--color-text-faint)] mb-1" />
      <div className="text-[11px] font-bold text-[var(--color-text)]">No photos yet</div>
      {canUpload && onUpload && (
        <button
          type="button"
          onClick={onUpload}
          className="mt-2 inline-flex items-center gap-1 h-8 px-2.5 rounded-lg text-[12px] font-bold text-[var(--color-surface)] bg-[var(--color-text)] hover:opacity-90"
        >
          <Upload className="w-3 h-3" /> Upload first photo
        </button>
      )}
    </div>
  );
}
