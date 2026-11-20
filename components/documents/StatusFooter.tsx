"use client";

import React from "react";
import { FileText, Folder, Layers, Loader2 } from "lucide-react";

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
      className="h-7 shrink-0 border-t border-[var(--color-border)] bg-[var(--color-surface)]/90 flex items-center gap-4 px-4 text-[11px] font-mono text-[var(--color-text-muted)] z-20"
      style={{ backdropFilter: "blur(12px)" }}
    >
      {/* Words only while something is loading; no "live" light. */}
      {loading && (
        <div className="flex items-center gap-1.5">
          <Loader2 className="w-3 h-3 animate-spin" />
          <span className="font-bold">Loading…</span>
        </div>
      )}

      <div className="flex items-center gap-1">
        <FileText className="w-3 h-3 text-[var(--color-text-faint)]" />
        <span>{docCount} {docCount === 1 ? "doc" : "docs"}</span>
      </div>

      <div className="flex items-center gap-1">
        <Folder className="w-3 h-3 text-[var(--color-text-faint)]" />
        <span>{folderCount} {folderCount === 1 ? "folder" : "folders"}</span>
      </div>

      {selectedCount > 0 && (
        <div className="flex items-center gap-1 text-[var(--color-text)] font-bold">
          <span>{selectedCount} selected</span>
        </div>
      )}

      {stagedCount > 0 && (
        <div className="flex items-center gap-1 text-[var(--color-text)] font-bold">
          <Layers className="w-3 h-3" />
          <span>{stagedCount} staged</span>
        </div>
      )}

      <div className="flex-1" />

      {/* Density toggle */}
      <div className="flex items-center gap-1 border border-[var(--color-border)] rounded-md p-0.5 bg-[var(--color-surface-2)]" role="group" aria-label="Row spacing">
        <button
          onClick={() => onDensityChange("compact")}
          aria-pressed={density === "compact"}
          className={`px-1.5 py-0.5 rounded text-[11px] font-bold transition-colors ${
            density === "compact" ? "bg-[var(--color-text)] text-[var(--color-surface)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          }`}
        >
          Compact
        </button>
        <button
          onClick={() => onDensityChange("comfy")}
          aria-pressed={density === "comfy"}
          className={`px-1.5 py-0.5 rounded text-[11px] font-bold transition-colors ${
            density === "comfy" ? "bg-[var(--color-text)] text-[var(--color-surface)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          }`}
        >
          Comfy
        </button>
      </div>
    </div>
  );
}
