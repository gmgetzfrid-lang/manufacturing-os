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
  Camera, Tag, Loader2,
} from "lucide-react";
import { useAssetByTag, findAssetsByTag, getAssetByTag, listAssetPhotos, invalidateAssetCache, type Asset } from "@/lib/assets";
import AssetPhotoCarousel from "./AssetPhotoCarousel";
import AssetPhotoUploader from "./AssetPhotoUploader";
import AssetPhotoPopover from "./AssetPhotoPopover";
import FileTagChip from "./FileTagChip";

interface AssetTagChipProps {
  tag: string;
  type?: string;
  orgId?: string;
  userId?: string;
  canManage?: boolean;
  size?: "compact" | "card";
  /** "photos" (default — gallery) or "files" (linked drawings → FileReferenceModal). */
  referenceKind?: "photos" | "files";
}


export default function AssetTagChip({
  tag, type = "Equipment", orgId, userId, canManage = false, size = "compact", referenceKind = "photos",
}: AssetTagChipProps) {
  // File-reference tags open linked drawings, not the photo gallery.
  if (referenceKind === "files") {
    return <FileTagChip tag={tag} type={type} orgId={orgId} userId={userId} canManage={canManage} />;
  }
  return <PhotoTagChip tag={tag} type={type} orgId={orgId} userId={userId} canManage={canManage} size={size} />;
}

function PhotoTagChip({
  tag, type = "Equipment", orgId, userId, canManage = false, size = "compact",
}: AssetTagChipProps) {
  const { showToast } = useToast();
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [carouselOpen, setCarouselOpen] = useState(false);
  const [uploaderOpen, setUploaderOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createdAsset, setCreatedAsset] = useState<Asset | null>(null);
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

    // No record yet: look it up. Clicking a tag never adds equipment; an
    // admin adds it on purpose, under its unit with its ID (Operating areas).
    if (!orgId || !userId) return;
    setCreating(true);
    try {
      const hits = await findAssetsByTag(orgId, tag);
      const asset = hits.length === 1 ? hits[0] : await getAssetByTag(orgId, tag);
      if (!asset) {
        showToast({ type: "info", title: hits.length > 1 ? `${tag} is on ${hits.length} units` : `${tag} isn't in the equipment list`,
          message: hits.length > 1 ? "Open it from its unit in Operating areas." : "Admins add equipment in Operating areas, under its unit." });
        return;
      }
      setCreatedAsset(asset);
      if (!canManage) { setPopoverOpen(true); return; }
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
    const baseClasses = "inline-flex items-center h-6 px-1.5 rounded border font-display text-[14px] font-semibold tabular-nums whitespace-nowrap transition-colors";
    let stateClasses: string;
    if (hasPhotos) {
      stateClasses = "text-[var(--color-text)] border-[var(--color-border)] hover:border-[var(--color-border-strong)] cursor-pointer bg-[var(--color-surface)]";
    } else if (interactive) {
      stateClasses = "bg-[var(--color-surface)] text-[var(--color-text)] border-[var(--color-border)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-2)] cursor-pointer";
    } else {
      stateClasses = "bg-[var(--color-surface)] text-[var(--color-text)] border-[var(--color-border)]";
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
                  ? `Quick look: ${photoCount} photo${photoCount === 1 ? "" : "s"} of ${tag}`
                  : cachedAsset
                    ? `Add photos to ${tag}`
                    : canManage
                      ? `Open ${tag} to add photos`
                      : tag
          }
          className={`${baseClasses} ${stateClasses}`}
        >
          <span>{tag}</span>
          {creating ? (
            <Loader2 className="w-3 h-3 ml-1 animate-spin text-[var(--color-text-muted)]" />
          ) : hasPhotos ? (
            <span className="ml-1 inline-flex items-center gap-0.5 font-sans text-[13px] font-semibold text-[var(--color-text-muted)]">
              <Camera className="w-3 h-3" />
              {photoCount}
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
            onUploaded={(allDone) => { invalidateAssetCache(); if (allDone) { setUploaderOpen(false); setPopoverOpen(true); } }}
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
      className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] shadow-sm hover:shadow-md hover:border-[var(--color-border)] transition-all"
    >
      <div className="p-1.5 bg-[var(--color-surface-2)] rounded-md">
        <Tag className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
      </div>
      <div className="text-left">
        <div className="text-[13px] font-semibold text-[var(--color-text)]">{tag}</div>
        <div className="text-[13px] text-[var(--color-text-muted)]">{type}</div>
      </div>
      {hasPhotos && (
        <div className="ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] text-[var(--color-text)] text-[13px] font-semibold">
          <Camera className="w-3 h-3" /> {photoCount}
        </div>
      )}
    </button>
  );
}
