"use client";
import { useToast } from "@/components/providers/ToastProvider";

// AssetTagChip — asset-registry-aware equipment tag chip.
//
// Click behavior (refined per UX feedback):
//   1. Single click opens a small *quick-look popover* anchored to
//      the chip. The user keeps their context (P&ID, inspector, viewer,
//      collection book) visible behind the popover.
//   2. The popover has an "expand" button that promotes to the
//      full-screen carousel for a longer look.
//   3. Auto-create-on-click stays: clicking a chip whose tag isn't yet
//      in the registry creates the asset record then opens the uploader.

import React, { useRef, useState } from "react";
import {
  Settings, Zap, Droplet, Box, Activity, Camera, Tag, Loader2,
} from "lucide-react";
import { useAssetByTag, createAsset, getAssetByTag, listAssetPhotos, invalidateAssetCache } from "@/lib/assets";
import AssetPhotoCarousel from "./AssetPhotoCarousel";
import AssetPhotoUploader from "./AssetPhotoUploader";
import AssetPhotoPopover from "./AssetPhotoPopover";

interface AssetTagChipProps {
  tag: string;
  type?: string;
  orgId?: string;
  userId?: string;
  canManage?: boolean;
  size?: "compact" | "card";
}

function getIconByType(type: string) {
  const t = (type || "").toLowerCase();
  if (t.includes("pump")) return <Activity className="w-3 h-3" />;
  if (t.includes("exchanger") || t.includes("heat")) return <Zap className="w-3 h-3" />;
  if (t.includes("vessel") || t.includes("tank")) return <Box className="w-3 h-3" />;
  if (t.includes("valve")) return <Droplet className="w-3 h-3" />;
  if (t.includes("instrument")) return <Zap className="w-3 h-3" />;
  return <Settings className="w-3 h-3" />;
}

export default function AssetTagChip({
  tag, type = "Equipment", orgId, userId, canManage = false, size = "compact",
}: AssetTagChipProps) {
  const { showToast } = useToast();
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [carouselOpen, setCarouselOpen] = useState(false);
  const [uploaderOpen, setUploaderOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createdAsset, setCreatedAsset] = useState<Awaited<ReturnType<typeof createAsset>> | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const lookup = useAssetByTag(orgId, tag);
  const cachedAsset = lookup.asset;
  const photoCount = lookup.photoCount;
  const asset = createdAsset || cachedAsset;

  const interactive = !!(orgId && userId);
  const hasPhotos = photoCount > 0;

  const onClick = async (e: React.MouseEvent) => {
    if (!interactive) return;
    e.preventDefault();
    e.stopPropagation();

    // Asset already in cache with photos → open quick-look popover.
    if (cachedAsset && hasPhotos) { setPopoverOpen(true); return; }
    // Asset exists, no photos. Managers go straight to uploader.
    if (cachedAsset && canManage)  { setUploaderOpen(true); return; }
    // Asset exists, no photos, non-manager — popover shows empty state.
    if (cachedAsset)               { setPopoverOpen(true); return; }

    // No asset record yet. Find-or-create flow.
    if (!orgId || !userId) return;
    if (!canManage) {
      // Non-managers do a lookup-only.
      setCreating(true);
      try {
        const existing = await getAssetByTag(orgId, tag);
        if (existing) {
          setCreatedAsset(existing);
          const photos = await listAssetPhotos(existing.id);
          if (photos.length > 0) setPopoverOpen(true);
          else setPopoverOpen(true);  // popover shows empty state too
        }
      } catch (err) {
        console.warn("Asset lookup failed:", err);
      } finally { setCreating(false); }
      return;
    }

    setCreating(true);
    try {
      let asset = await getAssetByTag(orgId, tag);
      if (!asset) {
        try {
          asset = await createAsset({ orgId, tag, createdBy: userId });
        } catch (createErr) {
          const msg = (createErr as Error).message || "";
          if (msg.includes("duplicate key") || msg.includes("23505")) {
            asset = await getAssetByTag(orgId, tag);
          } else {
            throw createErr;
          }
        }
      }
      if (!asset) throw new Error("Couldn't find or create asset record");
      invalidateAssetCache();
      setCreatedAsset(asset);

      const photos = await listAssetPhotos(asset.id);
      if (photos.length > 0) setPopoverOpen(true);
      else setUploaderOpen(true);
    } catch (err) {
      console.error("Open asset failed:", err);
      showToast({ type: "error", title: `Couldn't open ${tag}`, message: (err as Error).message });
    } finally {
      setCreating(false);
    }
  };

  const expandToFullScreen = () => {
    setPopoverOpen(false);
    setCarouselOpen(true);
  };

  if (size === "compact") {
    const baseClasses = "inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold border mr-1 mb-1 whitespace-nowrap shadow-sm transition-all";
    let stateClasses: string;
    if (hasPhotos) {
      stateClasses = "bg-gradient-to-br from-blue-50 to-blue-100/70 text-blue-800 border-blue-200 hover:border-blue-300 hover:from-blue-100 hover:to-blue-200 cursor-pointer";
    } else if (interactive) {
      stateClasses = "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)] hover:bg-blue-50 hover:border-blue-300 hover:text-blue-700 cursor-pointer";
    } else {
      stateClasses = "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]";
    }

    return (
      <>
        <button
          ref={buttonRef}
          onClick={onClick}
          disabled={!interactive || creating}
          title={
            !interactive
              ? tag
              : creating
                ? `Loading ${tag}…`
                : hasPhotos
                  ? `Quick-look — ${photoCount} photo${photoCount === 1 ? "" : "s"} of ${tag}`
                  : cachedAsset
                    ? `Add photos to ${tag}`
                    : canManage
                      ? `Click to add ${tag} + photos`
                      : tag
          }
          className={`${baseClasses} ${stateClasses}`}
        >
          <span className={hasPhotos ? "text-blue-500 mr-1" : "text-[var(--color-text-faint)] mr-1"}>
            {getIconByType(type)}
          </span>
          <span>{tag}</span>
          {creating ? (
            <Loader2 className="w-2.5 h-2.5 ml-1.5 animate-spin text-blue-500" />
          ) : hasPhotos ? (
            <span className="ml-1.5 inline-flex items-center gap-0.5 px-1 py-px rounded bg-white/80 text-blue-700 text-[9px] font-black">
              <Camera className="w-2.5 h-2.5" />
              {photoCount}
            </span>
          ) : interactive ? (
            <span className="ml-1.5 inline-flex items-center text-slate-300">
              <Camera className="w-2.5 h-2.5" />
            </span>
          ) : null}
        </button>

        {popoverOpen && asset && (
          <AssetPhotoPopover
            asset={asset}
            anchorEl={buttonRef.current}
            canManage={canManage}
            onClose={() => setPopoverOpen(false)}
            onExpandFull={expandToFullScreen}
            onUploadClick={canManage ? () => { setPopoverOpen(false); setUploaderOpen(true); } : undefined}
          />
        )}
        {carouselOpen && asset && (
          <AssetPhotoCarousel
            isOpen={carouselOpen}
            asset={asset}
            canManage={canManage}
            onClose={() => setCarouselOpen(false)}
            onUploadClick={() => { setCarouselOpen(false); setUploaderOpen(true); }}
          />
        )}
        {uploaderOpen && asset && userId && (
          <AssetPhotoUploader
            isOpen={uploaderOpen}
            asset={asset}
            userId={userId}
            onClose={() => setUploaderOpen(false)}
            onUploaded={() => { invalidateAssetCache(); setUploaderOpen(false); setPopoverOpen(true); }}
          />
        )}
      </>
    );
  }

  // Card mode (asset detail page)
  return (
    <button
      onClick={onClick}
      disabled={!interactive}
      className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] shadow-sm hover:shadow-md hover:border-blue-300 transition-all"
    >
      <div className="p-1.5 bg-blue-50 rounded-md">
        <Tag className="w-3.5 h-3.5 text-blue-600" />
      </div>
      <div className="text-left">
        <div className="text-xs font-black text-[var(--color-text)]">{tag}</div>
        <div className="text-[10px] text-[var(--color-text-muted)]">{type}</div>
      </div>
      {hasPhotos && (
        <div className="ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 text-[10px] font-black">
          <Camera className="w-3 h-3" /> {photoCount}
        </div>
      )}
    </button>
  );
}
