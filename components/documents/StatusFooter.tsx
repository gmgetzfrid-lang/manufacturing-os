"use client";

import React from "react";
import { FileText, Folder, Layers, Loader2 } from "lucide-react";
import { bandSeg, bandSegItem } from "@/components/admin/band";

interface StatusFooterProps {
  docCount: number;
  folderCount: number;
  stagedCount: number;
  selectedCount: number;
  loading?: boolean;
  density: "compact" | "comfy";
  onDensityChange: (d: "compact" | "comfy") => void;
  /** Kept for callers; "Find in library" in the top bar is the one home for
   *  the quick-jump, so the footer no longer repeats it. */
  onOpenCommand: () => void;
}

export default function StatusFooter({
  docCount,
  folderCount,
  stagedCount,
  selectedCount,
  loading,
  density,
  onDensityChange,
  onOpenCommand: _onOpenCommand,
}: StatusFooterProps) {
  return (
    <div
      className="h-9 shrink-0 border-t border-[var(--color-border)] bg-[var(--color-surface)] flex items-center gap-4 px-4 text-body tabular-nums text-[var(--color-text-muted)] z-20 max-sm:hidden"
    >
      {/* Words only while something is loading; no "live" light. */}
      {loading && (
        <div role="status" className="flex items-center gap-1.5">
          <Loader2 aria-hidden className="w-3 h-3 animate-spin" />
          <span>Loading…</span>
        </div>
      )}

      <div className="flex items-center gap-1">
        <FileText className="w-3 h-3 text-[var(--color-text-faint)]" />
        <span>{docCount.toLocaleString()} {docCount === 1 ? "document" : "documents"}</span>
      </div>

      <div className="flex items-center gap-1">
        <Folder className="w-3 h-3 text-[var(--color-text-faint)]" />
        <span>{folderCount} {folderCount === 1 ? "folder" : "folders"}</span>
      </div>

      {selectedCount > 0 && (
        <div className="flex items-center gap-1 text-[var(--color-text)] font-medium">
          <span>{selectedCount} selected</span>
        </div>
      )}

      {stagedCount > 0 && (
        <div className="flex items-center gap-1 text-[var(--color-text)] font-medium">
          <Layers className="w-3 h-3" />
          <span>{stagedCount} staged</span>
        </div>
      )}

      <div className="flex-1" />

      {/* Row spacing */}
      <div className={`${bandSeg} !p-0.5`} role="group" aria-label="Row spacing">
        <button
          type="button"
          onClick={() => onDensityChange("compact")}
          aria-pressed={density === "compact"}
          className={`${bandSegItem(density === "compact")} !h-6 !px-2 !text-body`}
        >
          Compact
        </button>
        <button
          type="button"
          onClick={() => onDensityChange("comfy")}
          aria-pressed={density === "comfy"}
          className={`${bandSegItem(density === "comfy")} !h-6 !px-2 !text-body`}
        >
          Roomy
        </button>
      </div>
    </div>
  );
}
