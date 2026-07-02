"use client";

// OriginBadge — a sky badge marking a document of EXTERNAL origin (OEM / standard
// / regulator / vendor), showing the source + its own reference. Renders nothing
// for internally-authored documents (the default), to avoid clutter.

import React from "react";
import { Globe } from "lucide-react";

export default function OriginBadge({ origin, source, reference, edition, className = "" }: {
  origin?: "internal" | "external" | null;
  source?: string | null;
  reference?: string | null;
  edition?: string | null;
  className?: string;
}) {
  if (origin !== "external") return null;
  const label = [source, reference].map((s) => s?.trim()).filter(Boolean).join(" ") || "External";
  return (
    <span
      title={`External origin${edition ? ` · ${edition}` : ""}`}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold whitespace-nowrap bg-sky-50 text-sky-700 border-sky-200 ${className}`}
    >
      <Globe className="w-3 h-3 shrink-0" /> {label}
    </span>
  );
}
