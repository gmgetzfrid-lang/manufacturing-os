"use client";

// AssetTagChip — asset-registry-aware equipment tag chip.
//
// Three states based on registry data:
//   has photos     → click opens carousel directly (blue gradient + camera+count)
//   asset, 0 photos → click opens uploader (slate + faint camera icon hint)
//   no asset yet   → click silently creates the asset, then opens uploader
//                    (slate + faint camera icon hint)
//
// In every case the chip looks clickable when orgId+userId is passed,
// so users always have a way to add photos to ANY equipment tag.

import React, { useState } from "react";
import {
  Settings, Zap, Droplet, Box, Activity, Camera, Tag, Loader2,
} from "lucide-react";
import { useAssetByTag, createAsset, invalidateAssetCache } from "@/lib/assets";
import AssetPhotoCarousel from "./AssetPhotoCarousel";
import AssetPhotoUploader from "./AssetPhotoUploader";

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
  const [carouselOpen, setCarouselOpen] = useState(false);
  const [uploaderOpen, setUploaderOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  // After auto-create, store the freshly-created asset so we can pass it
  // to the uploader (the cache may not have refreshed yet).
  const [createdAsset, setCreatedAsset] = useState<Awaited<ReturnType<typeof createAsset>> | null>(null);

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

    // Case 1: asset has photos → carousel
    if (cachedAsset && hasPhotos) {
      setCarouselOpen(true);
      return;
    }
    // Case 2: asset exists but no photos → uploader
    if (cachedAsset) {
      setUploaderOpen(true);
      return;
    }
    // Case 3: no asset yet → auto-create then open uploader
    if (!canManage) {
      // Non-managers can't create assets; do nothing
      return;
    }
    if (!orgId || !userId) return;
    setCreating(true);
    try {
      const fresh = await createAsset({
        orgId,
        tag,
        description: undefined,
        createdBy: userId,
      });
      invalidateAssetCache();
      setCreatedAsset(fresh);
      setUploaderOpen(true);
    } catch (err) {
      console.error("Auto-create asset failed:", err);
      alert(`Couldn't add ${tag} to the asset registry: ${(err as Error).message}`);
    } finally {
      setCreating(false);
    }
  };

  if (size === "compact") {
    // Visual classes vary by state for clear affordance
    const baseClasses = "inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold border mr-1 mb-1 whitespace-nowrap shadow-sm transition-all";
    let stateClasses: string;
    if (hasPhotos) {
      stateClasses = "bg-gradient-to-br from-blue-50 to-blue-100/70 text-blue-800 border-blue-200 hover:border-blue-300 hover:from-blue-100 hover:to-blue-200 cursor-pointer";
    } else if (interactive) {
      stateClasses = "bg-slate-100 text-slate-700 border-slate-200 hover:bg-blue-50 hover:border-blue-300 hover:text-blue-700 cursor-pointer";
    } else {
      stateClasses = "bg-slate-100 text-slate-700 border-slate-200";
    }

    return (
      <>
        <button
          onClick={onClick}
          disabled={!interactive || creating}
          title={
            !interactive
              ? tag
              : creating
                ? `Adding ${tag} to registry…`
                : hasPhotos
                  ? `View ${photoCount} photo${photoCount === 1 ? "" : "s"} of ${tag}`
                  : cachedAsset
                    ? `Add photos to ${tag}`
                    : canManage
                      ? `Click to add ${tag} to the asset registry and upload photos`
                      : tag
          }
          className={`${baseClasses} ${stateClasses}`}
        >
          <span className={hasPhotos ? "text-blue-500 mr-1" : "text-slate-400 mr-1"}>
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
            // Subtle "click to add photos" hint — always visible so users
            // know the chip is interactive even without photos yet.
            <span className="ml-1.5 inline-flex items-center text-slate-300 hover:text-blue-500 transition-colors">
              <Camera className="w-2.5 h-2.5" />
            </span>
          ) : null}
        </button>

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
            onUploaded={() => { invalidateAssetCache(); setUploaderOpen(false); setCarouselOpen(true); }}
          />
        )}
      </>
    );
  }

  // Card mode (asset detail page, future)
  return (
    <button
      onClick={onClick}
      disabled={!interactive}
      className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-white border border-slate-200 shadow-sm hover:shadow-md hover:border-blue-300 transition-all"
    >
      <div className="p-1.5 bg-blue-50 rounded-md">
        <Tag className="w-3.5 h-3.5 text-blue-600" />
      </div>
      <div className="text-left">
        <div className="text-xs font-black text-slate-900">{tag}</div>
        <div className="text-[10px] text-slate-500">{type}</div>
      </div>
      {hasPhotos && (
        <div className="ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 text-[10px] font-black">
          <Camera className="w-3 h-3" /> {photoCount}
        </div>
      )}
    </button>
  );
}
