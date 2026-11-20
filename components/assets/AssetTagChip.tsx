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
  Settings, Zap, Droplet, Box, Activity, Camera, Tag, Loader2, Plus,
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

/** The equipment type's icon. The column's type word decides it when it
 *  names one (pump, exchanger, vessel, valve, instrument); otherwise the
 *  tag's letter does (P pump, E exchanger, V/D/T vessel); else a gear. */
function getIconByType(type: string, tag = "") {
  const t = (type || "").toLowerCase();
  if (t.includes("pump")) return <Activity className="w-3 h-3" />;
  if (t.includes("exchanger") || t.includes("heat")) return <Zap className="w-3 h-3" />;
  if (t.includes("vessel") || t.includes("tank")) return <Box className="w-3 h-3" />;
  if (t.includes("valve")) return <Droplet className="w-3 h-3" />;
  if (t.includes("instrument")) return <Zap className="w-3 h-3" />;
  const lead = (tag.trim().match(/^[A-Za-z]+/)?.[0] ?? "").toUpperCase();
  if (lead === "P") return <Activity className="w-3 h-3" />;
  if (lead === "E") return <Zap className="w-3 h-3" />;
  if (lead === "V" || lead === "D" || lead === "T") return <Box className="w-3 h-3" />;
  return <Settings className="w-3 h-3" />;
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

  // Finds the equipment record for the camera button when it isn't cached
  // yet. Never adds equipment; says why when it can't be found.
  const resolveAsset = async (): Promise<Asset | null> => {
    if (asset) return asset;
    if (!orgId) return null;
    setCreating(true);
    try {
      const hits = await findAssetsByTag(orgId, tag);
      const found = hits.length === 1 ? hits[0] : await getAssetByTag(orgId, tag);
      if (!found) {
        showToast({ type: "info", title: hits.length > 1 ? `${tag} is on ${hits.length} units` : `${tag} isn't in the equipment list`,
          message: hits.length > 1 ? "Open it from its unit in Operating areas." : "Admins add equipment in Operating areas, under its unit." });
        return null;
      }
      setCreatedAsset(found);
      return found;
    } catch (err) {
      showToast({ type: "error", title: `Couldn't open ${tag}`, message: (err as Error).message });
      return null;
    } finally {
      setCreating(false);
    }
  };

  // The camera inside the pill: the carousel when it has photos, the
  // uploader for people who add them when it has none.
  const onCamera = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!interactive) return;
    if (hasPhotos) {
      if (await resolveAsset()) setCarouselOpen(true);
      return;
    }
    if (canManage && (await resolveAsset())) setUploaderOpen(true);
  };

  const expandToFullScreen = () => {
    setPopoverOpen(false);
    setCarouselOpen(true);
  };

  if (size === "compact") {
    // A pill with buttons in it: the type icon and the tag (opens the quick
    // look, or the asset), then, behind a hairline, a camera: the photo count
    // that opens the carousel, or "+" to add photos for people who may.
    const tagTitle = !interactive
      ? tag
      : creating
        ? `Loading ${tag}…`
        : hasPhotos
          ? `Quick look at ${tag}`
          : cachedAsset && canManage
            ? `Add photos to ${tag}`
            : `Open ${tag}`;
    const showCamera = interactive && (hasPhotos || canManage);
    const seg = "h-full inline-flex items-center gap-1 transition-colors hover:bg-[var(--color-main)] hover:text-white focus-visible:outline-2 focus-visible:-outline-offset-2 disabled:cursor-wait";

    if (!interactive) {
      return (
        <span className="ui-tag tabular-nums">
          <span className="text-[var(--color-main)]" aria-hidden>{getIconByType(type, tag)}</span>
          {tag}
        </span>
      );
    }

    return (
      <>
        {/* The pill's clicks are its own: never the row's select or open. */}
        <span className="ui-tag tabular-nums shrink-0 !p-0 !gap-0 overflow-hidden"
          onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          <button
            ref={buttonRef}
            type="button"
            onClick={onClick}
            disabled={creating}
            title={tagTitle}
            aria-label={tagTitle}
            className={`group/tag ${seg} pl-1.5 ${showCamera ? "pr-1.5" : "pr-2"}`}
          >
            <span className="text-[var(--color-main)] group-hover/tag:text-white" aria-hidden>
              {creating ? <Loader2 className="w-3 h-3 animate-spin" /> : getIconByType(type, tag)}
            </span>
            <span>{tag}</span>
          </button>
          {showCamera && (
            <button
              type="button"
              onClick={(e) => void onCamera(e)}
              disabled={creating}
              title={hasPhotos ? `See ${photoCount} photo${photoCount === 1 ? "" : "s"} of ${tag}` : `Add photos to ${tag}`}
              aria-label={hasPhotos ? `See ${photoCount} photo${photoCount === 1 ? "" : "s"} of ${tag}` : `Add photos to ${tag}`}
              className={`${seg} px-1.5 border-l border-[color-mix(in_srgb,var(--color-main)_22%,transparent)] font-sans text-[12px] font-bold`}
            >
              <Camera className="w-3 h-3" aria-hidden />
              {hasPhotos ? photoCount : <Plus className="w-2.5 h-2.5 -ml-0.5" aria-hidden />}
            </button>
          )}
        </span>

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
      <span className="ui-icon-tile is-sm">
        <Tag className="w-3.5 h-3.5" />
      </span>
      <div className="text-left">
        <div className="ui-id text-[15px]">{tag}</div>
        <div className="text-[13px] text-[var(--color-text-muted)]">{type}</div>
      </div>
      {hasPhotos && (
        <span className="ml-2 ui-count gap-1">
          <Camera className="w-3 h-3" /> {photoCount}
        </span>
      )}
    </button>
  );
}
