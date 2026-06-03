"use client";

// PageBackground — a bounded, behind-content page background for a library
// root or folder. Rendered as a -z layer so the opaque content cards
// always sit on top (text never lands directly on the image). Two kinds:
//   * tint  — a soft theme wash (brand or neutral)
//   * image — a cover photo at clamped low opacity over the canvas color
// Image paths are signed at render (7-day) and cached.

import React, { useEffect, useState } from "react";
import { getSignedUrlForPath } from "@/lib/storage";
import type { ResolvedBackground } from "@/lib/pageHeader";

const cache = new Map<string, string>();

export default function PageBackground({ bg }: { bg: ResolvedBackground }) {
  const [src, setSrc] = useState<string | undefined>(bg.imagePath ? cache.get(bg.imagePath) : undefined);

  useEffect(() => {
    const path = bg.imagePath;
    if (bg.type !== "image" || !path || cache.has(path)) return;
    let active = true;
    getSignedUrlForPath(path, 604800)
      .then((u) => { cache.set(path, u); if (active) setSrc(u); })
      .catch(() => { /* fall back to tint base */ });
    return () => { active = false; };
  }, [bg.type, bg.imagePath]);

  const tintBase = bg.tint === "brand"
    ? "color-mix(in srgb, var(--color-accent) 12%, var(--color-canvas))"
    : "var(--color-surface-2)";

  if (bg.type === "tint") {
    return <div className="absolute inset-0 -z-10 pointer-events-none" style={{ background: tintBase }} aria-hidden />;
  }

  // image
  return (
    <div className="absolute inset-0 -z-10 pointer-events-none overflow-hidden" style={{ background: "var(--color-canvas)" }} aria-hidden>
      {src && (
        <div
          className="absolute inset-0 bg-center bg-cover"
          style={{ backgroundImage: `url(${src})`, opacity: bg.opacity }}
        />
      )}
      {/* soft brand wash on top of the photo to harmonize with the palette */}
      {bg.tint === "brand" && (
        <div className="absolute inset-0" style={{ background: "var(--brand-gradient)", opacity: 0.06 }} />
      )}
    </div>
  );
}
