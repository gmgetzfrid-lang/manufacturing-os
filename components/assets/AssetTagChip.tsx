"use client";

// AssetTagChip — replaces the dumb AssetTag visual chip with one that
// looks up the asset registry, shows a photo count badge when photos
// exist, and opens the carousel on click.
//
// Drop-in compatible visually with the existing AssetTag (same size,
// same iconography) so we can adopt it incrementally — anywhere we
// pass an orgId it becomes interactive, anywhere we don't it just
// renders as a static chip.

import React, { useState } from "react";
import {
  Settings, Zap, Droplet, Box, Activity, Camera, Tag,
} from "lucide-react";
import { useAssetByTag } from "@/lib/assets";
import AssetPhotoCarousel from "./AssetPhotoCarousel";
import AssetPhotoUploader from "./AssetPhotoUploader";

interface AssetTagChipProps {
  tag: string;
  type?: string;
  orgId?: string;
  userId?: string;
  canManage?: boolean;
  /** Render style. 'compact' is the row inline chip; 'card' is bigger. */
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

  const lookup = useAssetByTag(orgId, tag);
  const asset = lookup.asset;
  const photoCount = lookup.photoCount;

  const interactive = !!(orgId && userId);
  const hasPhotos = photoCount > 0;

  const onClick = (e: React.MouseEvent) => {
    if (!interactive) return;
    e.preventDefault();
    e.stopPropagation();
    if (asset) setCarouselOpen(true);
  };

  // Compact mode = inline pill (used in doc rows, inspector)
  if (size === "compact") {
    return (
      <>
        <button
          onClick={onClick}
          disabled={!interactive}
          title={interactive ? (hasPhotos ? `View ${photoCount} photo${photoCount === 1 ? "" : "s"} of ${tag}` : `View ${tag}`) : tag}
          className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold border mr-1 mb-1 whitespace-nowrap shadow-sm transition-all ${
            hasPhotos
              ? "bg-gradient-to-br from-blue-50 to-blue-100/70 text-blue-800 border-blue-200 hover:border-blue-300 hover:from-blue-100 hover:to-blue-200 cursor-pointer"
              : interactive
                ? "bg-slate-100 text-slate-700 border-slate-200 hover:bg-white hover:border-blue-300 hover:text-blue-600 cursor-pointer"
                : "bg-slate-100 text-slate-700 border-slate-200"
          }`}
        >
          <span className={hasPhotos ? "text-blue-500 mr-1" : "text-slate-400 mr-1"}>
            {getIconByType(type)}
          </span>
          <span>{tag}</span>
          {hasPhotos && (
            <span className="ml-1.5 inline-flex items-center gap-0.5 px-1 py-px rounded bg-white/80 text-blue-700 text-[9px] font-black">
              <Camera className="w-2.5 h-2.5" />
              {photoCount}
            </span>
          )}
        </button>

        {/* Modals — only mount when open to avoid loading photos preemptively */}
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
            onUploaded={() => { setUploaderOpen(false); setCarouselOpen(true); }}
          />
        )}
      </>
    );
  }

  // Card mode = bigger callout (used in asset detail pages)
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
