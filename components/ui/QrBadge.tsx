"use client";

// QrBadge — the one QR renderer for every screen surface.
//
// Point-and-scan beats type-and-search: this exists so any surface can turn
// "the thing you're looking at" into "the thing on your phone" with zero
// configuration. Generates locally (qrcode lib), renders as a plain <img>,
// silent on failure.

import React, { useEffect, useState } from "react";

interface QrBadgeProps {
  /** The URL (or text) to encode. */
  value: string;
  /** Rendered size in px. Default 128. */
  size?: number;
  /** Optional caption under the code. */
  caption?: string;
  className?: string;
}

export default function QrBadge({ value, size = 128, caption, className }: QrBadgeProps) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const { toDataURL } = await import("qrcode");
        const url = await toDataURL(value, { margin: 1, width: size * 2 });
        if (alive) setDataUrl(url);
      } catch {
        if (alive) setDataUrl(null);
      }
    })();
    return () => { alive = false; };
  }, [value, size]);

  if (!dataUrl) return null;
  return (
    <div className={`inline-flex flex-col items-center gap-1 ${className ?? ""}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={dataUrl}
        alt="QR code"
        width={size}
        height={size}
        className="rounded-lg border border-[var(--color-border)] bg-white p-1"
      />
      {caption && (
        <span className="text-[10px] text-[var(--color-text-muted)] text-center max-w-[160px] leading-tight">
          {caption}
        </span>
      )}
    </div>
  );
}
