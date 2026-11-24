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
import { useAssetByTag, resolveEquipment, listAssetPhotos, invalidateAssetCache, type Asset, type EquipmentLookup } from "@/lib/assets";
import { parseEquipmentLabel } from "@/lib/equipmentIdentity";
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
  /** It's the tag a search or filter asked for: ringed so it stands out. */
  hit?: boolean;
  /** The unit it's on, when the place it's shown knows (a tag repeats from unit to unit). */
  unitCode?: string | null;
}

/** Why a label didn't open equipment, in words. */
function notFound(tag: string, r: EquipmentLookup): { title: string; message: string } {
  const l = parseEquipmentLabel(tag);
  const name = l.tag ?? tag;
  if (r.why === "ambiguous") {
    return r.units.length > 1
      ? { title: `${name} is on ${r.units.length} units`, message: "Open it from its unit in Operating areas." }
      : { title: `Unit ${r.units[0] ?? "?"} has more than one ${name}`, message: "Open it from Operating areas, by its ID." };
  }
  if (r.why === "other-id") {
    const ids = [...new Set(r.candidates.map((a) => a.code).filter(Boolean))].join(", ");
    return { title: `${tag} isn't in the equipment list`, message: `The list has ${name} as ${ids}. Admins fix IDs in Operating areas.` };
  }
  return { title: `${tag} isn't in the equipment list`, message: "Admins add equipment in Operating areas, under its unit." };
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
  tag, type = "Equipment", orgId, userId, canManage = false, size = "compact", referenceKind = "photos", hit = false, unitCode,
}: AssetTagChipProps) {
  // File-reference tags open linked drawings, not the photo gallery.
  if (referenceKind === "files") {
    return <FileTagChip tag={tag} type={type} orgId={orgId} userId={userId} canManage={canManage} unitCode={unitCode} />;
  }
  return <PhotoTagChip tag={tag} type={type} orgId={orgId} userId={userId} canManage={canManage} size={size} hit={hit} unitCode={unitCode} />;
}

function PhotoTagChip({
  tag, type = "Equipment", orgId, userId, canManage = false, size = "compact", hit = false, unitCode,
}: AssetTagChipProps) {
  const { showToast } = useToast();
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [carouselOpen, setCarouselOpen] = useState(false);
  const [uploaderOpen, setUploaderOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createdAsset, setCreatedAsset] = useState<Asset | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // "X-31 (2030.31)" is found by its ID, 2030.31; X-31 is its second name.
  const lookup = useAssetByTag(orgId, tag, unitCode);
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
      const found = await resolveEquipment(orgId, tag, unitCode);
      const asset = found.asset;
      if (!asset) { showToast({ type: "info", ...notFound(tag, found) }); return; }
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
      const r = await resolveEquipment(orgId, tag, unitCode);
      if (!r.asset) { showToast({ type: "info", ...notFound(tag, r) }); return null; }
      setCreatedAsset(r.asset);
      return r.asset;
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
        <span className={`ui-tag tabular-nums ${hit ? "ring-2 ring-[var(--color-accent)]" : ""}`} data-hit={hit || undefined}>
          <span className="text-[var(--color-main)]" aria-hidden>{getIconByType(type, tag)}</span>
          {tag}
        </span>
      );
    }

    return (
      <>
        {/* The pill's clicks are its own: never the row's select or open. */}
        <span className={`ui-tag tabular-nums shrink-0 !p-0 !gap-0 overflow-hidden ${hit ? "ring-2 ring-[var(--color-accent)]" : ""}`} data-hit={hit || undefined}
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
              className={`${seg} px-1.5 border-l border-[color-mix(in_srgb,var(--color-main)_22%,transparent)] font-sans text-caption font-medium`}
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
        <div className="ui-id text-reading">{tag}</div>
        <div className="text-body text-[var(--color-text-muted)]">{type}</div>
      </div>
      {hasPhotos && (
        <span className="ml-2 ui-count gap-1">
          <Camera className="w-3 h-3" /> {photoCount}
        </span>
      )}
    </button>
  );
}
