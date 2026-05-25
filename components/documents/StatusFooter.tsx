"use client";

import React from "react";
import { FileText, Folder, Layers, Command, Activity } from "lucide-react";

interface StatusFooterProps {
  docCount: number;
  folderCount: number;
  stagedCount: number;
  selectedCount: number;
  loading?: boolean;
  density: "compact" | "comfy";
  onDensityChange: (d: "compact" | "comfy") => void;
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
  onOpenCommand,
}: StatusFooterProps) {
  return (
    <div
      className="h-7 shrink-0 border-t border-slate-200 bg-white/80 flex items-center gap-4 px-4 text-[10px] font-mono text-slate-500 z-20"
      style={{ backdropFilter: "blur(12px)" }}
    >
      <div className="flex items-center gap-1.5">
        <Activity className={`w-2.5 h-2.5 ${loading ? "text-blue-500 animate-pulse" : "text-emerald-500"}`} />
        <span className="font-bold">{loading ? "SYNCING" : "LIVE"}</span>
      </div>

      <div className="w-px h-3 bg-slate-200" />

      <div className="flex items-center gap-1">
        <FileText className="w-2.5 h-2.5 text-slate-400" />
        <span>{docCount} {docCount === 1 ? "doc" : "docs"}</span>
      </div>

      <div className="flex items-center gap-1">
        <Folder className="w-2.5 h-2.5 text-slate-400" />
        <span>{folderCount} {folderCount === 1 ? "folder" : "folders"}</span>
      </div>

      {selectedCount > 0 && (
        <div className="flex items-center gap-1 text-blue-600 font-bold">
          <span>● {selectedCount} selected</span>
        </div>
      )}

      {stagedCount > 0 && (
        <div className="flex items-center gap-1 text-orange-600 font-bold">
          <Layers className="w-2.5 h-2.5" />
          <span>{stagedCount} staged</span>
        </div>
      )}

      <div className="flex-1" />

      {/* Density toggle */}
      <div className="flex items-center gap-1 border border-slate-200 rounded-md p-0.5 bg-slate-50/80">
        <button
          onClick={() => onDensityChange("compact")}
          className={`px-1.5 py-0.5 rounded text-[9px] font-bold transition-colors ${
            density === "compact" ? "bg-slate-900 text-white" : "text-slate-500 hover:text-slate-700"
          }`}
        >
          Compact
        </button>
        <button
          onClick={() => onDensityChange("comfy")}
          className={`px-1.5 py-0.5 rounded text-[9px] font-bold transition-colors ${
            density === "comfy" ? "bg-slate-900 text-white" : "text-slate-500 hover:text-slate-700"
          }`}
        >
          Comfy
        </button>
      </div>

      <button
        onClick={onOpenCommand}
        className="flex items-center gap-1 px-2 py-0.5 rounded-md border border-slate-200 bg-slate-50/80 hover:bg-white hover:border-slate-300 transition-all text-slate-600 hover:text-slate-900"
        title="Open command palette"
      >
        <Command className="w-2.5 h-2.5" />
        <span>K</span>
      </button>
    </div>
  );
}
