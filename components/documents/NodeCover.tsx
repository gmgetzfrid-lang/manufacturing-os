"use client";

// NodeCover — the visual header/cover for a customized library or folder.
// Renders one of:
//   * a cover IMAGE, optionally recolored:
//       - tint "brand" → duotone in the workspace palette (grayscale the
//         photo, then paint it with the brand gradient via blend modes)
//       - tint "mono"  → grayscale
//   * or a COLOR/brand gradient panel with the chosen icon.
// The brand-duotone is the "better than SharePoint" touch: covers
// automatically harmonize with the active theme palette.

import React, { useEffect, useState } from "react";
import { NodeIcon } from "@/lib/nodeIcons";
import { peekSignedUrl, subscribeSignedUrl } from "@/lib/storage";

export interface NodeAppearanceLike {
  color?: string | null;
  icon?: string | null;
  coverImageUrl?: string | null;
  coverTint?: "none" | "brand" | "mono" | null;
}

// Covers may be a direct URL (pasted) or an R2 storage path (uploaded).
// Storage paths need a signed URL: lib/storage caches one per path for the
// window the SERVER granted (EGR-4 / DEC-44 §2 — an hour, not a requested
// week) so a grid of covers doesn't re-sign per render, and the subscription
// re-signs before the window closes so a cover left on screen never 403s.
const isDirectUrl = (s: string) => /^(https?:|data:|blob:)/i.test(s);

function useCoverSrc(cover?: string): string | undefined {
  const direct = !!cover && isDirectUrl(cover);
  // Seed from the shared cache during render (pure map read); the effect
  // owns freshness and re-signing, so no setState-in-render cascade.
  const cachedUrl = cover && !direct ? peekSignedUrl(cover)?.url : undefined;
  const [signed, setSigned] = useState<string | undefined>(cachedUrl);
  useEffect(() => {
    if (!cover || direct) return;
    // null = could not be signed → fall back to the color panel
    return subscribeSignedUrl(cover, (u) => setSigned(u ?? undefined));
  }, [cover, direct]);
  if (direct) return cover;
  return signed ?? cachedUrl;
}

export default function NodeCover({
  appearance,
  className = "",
  rounded = "rounded-xl",
  iconSize = "w-6 h-6",
  showIcon = true,
}: {
  appearance: NodeAppearanceLike;
  className?: string;
  rounded?: string;
  iconSize?: string;
  showIcon?: boolean;
}) {
  const color = appearance.color || undefined;
  const cover = appearance.coverImageUrl || undefined;
  const tint = appearance.coverTint ?? "none";
  const coverSrc = useCoverSrc(cover);

  if (cover && coverSrc) {
    return (
      <div className={`relative overflow-hidden ${rounded} ${className}`}>
        {/* eslint-disable-next-line @next/next/no-img-element -- covers are arbitrary external URLs / signed storage URLs; next/image can't optimize without domain config */}
        <img
          src={coverSrc}
          alt=""
          className="absolute inset-0 w-full h-full object-cover"
          style={tint === "mono" || tint === "brand" ? { filter: "grayscale(1) contrast(1.05)" } : undefined}
          draggable={false}
        />
        {tint === "brand" && (
          <>
            {/* duotone: paint shadows with primary, highlights with secondary */}
            <div className="absolute inset-0" style={{ background: "var(--brand-gradient)", mixBlendMode: "color", opacity: 0.85 }} />
            <div className="absolute inset-0" style={{ background: "var(--brand-gradient)", mixBlendMode: "multiply", opacity: 0.35 }} />
          </>
        )}
        {/* legibility scrim */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/35 via-transparent to-transparent" />
        {showIcon && (
          <div className="absolute top-2 left-2 w-9 h-9 rounded-lg grid place-items-center bg-white/15 backdrop-blur-sm text-white ring-1 ring-white/25">
            <NodeIcon name={appearance.icon} className={iconSize} />
          </div>
        )}
      </div>
    );
  }

  // No image → color/brand gradient panel with the icon.
  const bg = color
    ? `linear-gradient(135deg, ${color}, color-mix(in srgb, ${color} 55%, #000))`
    : "var(--brand-gradient)";
  return (
    <div className={`relative grid place-items-center ${rounded} ${className}`} style={{ background: bg }}>
      {showIcon && <NodeIcon name={appearance.icon} className={`${iconSize} text-white drop-shadow`} />}
    </div>
  );
}
