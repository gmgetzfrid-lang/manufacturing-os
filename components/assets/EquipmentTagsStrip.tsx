"use client";

// EquipmentTagsStrip — renders a row of asset-aware AssetTagChip
// instances for every tag-typed metadata field on a document.
//
// Used in two places:
//   - Inspector panel (so users see tags without opening the metadata
//     editor)
//   - Full-screen PDF viewer (floating bar at top so users can pull
//     up photos of equipment while studying the drawing)
//
// Tag identification: we walk through document.metadata and treat
// every value that's an Array<string> as a tag group. The library's
// customColumns is the canonical source of truth (it tells us which
// columns are type='tags'), but we accept either path so this works
// even when columns aren't available.

import React from "react";
import { Tag, Info } from "lucide-react";
import AssetTagChip from "./AssetTagChip";
import { collectTagGroups, type TagColumnDef } from "@/lib/documentTags";

interface EquipmentTagsStripProps {
  metadata?: Record<string, unknown> | null;
  customColumns?: TagColumnDef[];
  orgId?: string;
  userId?: string;
  canManage?: boolean;
  /** Compact = ribbon style for floating bars. Inspector = stacked with labels. */
  variant?: "ribbon" | "stacked";
  className?: string;
}

export default function EquipmentTagsStrip({
  metadata, customColumns, orgId, userId, canManage = false,
  variant = "stacked", className = "",
}: EquipmentTagsStripProps) {
  const groups = collectTagGroups(metadata, customColumns);

  if (groups.length === 0) return null;

  if (variant === "ribbon") {
    // Compact horizontal ribbon — used in floating bars on top of
    // the full-screen viewer. All groups flatten to a single scrollable
    // row.
    const allTags = groups.flatMap((g) => g.tags.map((t) => ({ tag: t, label: g.label, referenceKind: g.referenceKind })));
    return (
      <div className={`flex items-center gap-1.5 overflow-x-auto ${className}`} onClick={(e) => e.stopPropagation()}>
        <Tag className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0 ml-0.5" />
        <div className="flex items-center gap-1 flex-nowrap">
          {allTags.map(({ tag, label, referenceKind }, i) => (
            <AssetTagChip
              key={`${tag}-${i}`}
              tag={tag}
              type={label}
              orgId={orgId}
              userId={userId}
              canManage={canManage}
              referenceKind={referenceKind}
            />
          ))}
        </div>
      </div>
    );
  }

  // Stacked — used in the Inspector. Each group gets its own labeled
  // row with the tags flowed below.
  return (
    <div className={`space-y-2 ${className}`} onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-1.5">
        <Tag className="w-3.5 h-3.5 text-blue-600" />
        <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text)]">
          Equipment & Asset Tags
        </span>
        <span className="text-[10px] text-[var(--color-text-faint)] ml-auto inline-flex items-center gap-1">
          <Info className="w-2.5 h-2.5" /> Click any tag for photos
        </span>
      </div>
      {groups.map((g) => (
        <div key={g.key} className="bg-slate-50/60 border border-[var(--color-border)] rounded-lg p-2">
          <div className="text-[9px] font-bold uppercase tracking-widest text-[var(--color-text-muted)] mb-1">
            {g.label} <span className="text-[var(--color-text-faint)] font-normal normal-case">· {g.tags.length}</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {g.tags.map((t, i) => (
              <AssetTagChip
                key={`${t}-${i}`}
                tag={t}
                type={g.label}
                orgId={orgId}
                userId={userId}
                canManage={canManage}
                referenceKind={g.referenceKind}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
