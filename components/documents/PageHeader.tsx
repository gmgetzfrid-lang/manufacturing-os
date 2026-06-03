"use client";

// PageHeader — the SharePoint-style hero band at the top of a library
// root or folder page. Background is the resolved cover (image+tint) or
// color/brand panel (reusing NodeCover); the title/description/icon are
// overlaid on a legibility scrim so text always reads. Height is preset.

import React from "react";
import NodeCover from "@/components/documents/NodeCover";
import { NodeIcon } from "@/lib/nodeIcons";
import type { ResolvedHeader } from "@/lib/pageHeader";

const HEIGHT_CLASS: Record<ResolvedHeader["height"], string> = {
  compact: "h-20",
  standard: "h-36",
  tall: "h-56",
};

export default function PageHeader({ header, actions }: { header: ResolvedHeader; actions?: React.ReactNode }) {
  return (
    <div className={`relative w-full overflow-hidden rounded-2xl ${HEIGHT_CLASS[header.height]} mb-4 shadow-sm`}>
      <NodeCover
        appearance={{ color: header.color, icon: header.icon, coverImageUrl: header.coverImageUrl, coverTint: header.coverTint }}
        className="absolute inset-0 w-full h-full"
        rounded="rounded-none"
        showIcon={false}
      />
      {/* extra bottom scrim for title legibility on top of NodeCover's own */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/15 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 p-4 flex items-end gap-3">
        <span className="w-11 h-11 rounded-xl grid place-items-center bg-white/15 backdrop-blur-sm text-white ring-1 ring-white/25 shrink-0">
          <NodeIcon name={header.icon} className="w-5 h-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-lg sm:text-xl font-black text-white drop-shadow truncate">{header.title}</h1>
          {header.description && header.height !== "compact" && (
            <p className="text-sm text-white/85 drop-shadow line-clamp-1">{header.description}</p>
          )}
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>
    </div>
  );
}
