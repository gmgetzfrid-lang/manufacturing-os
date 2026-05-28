"use client";

// EquipmentTile — single equipment card on the turnaround whiteboard.
//
// Two interactions:
//   - Click anywhere on the tile        → advance state (next in cycle)
//   - Right-click / Shift-click / ⋮ btn → open state menu (pick any state)
//
// Optimistic UI: the calling page mutates local state immediately so
// the tile visually jumps to the new column before the DB roundtrip
// completes. If the server call fails, the page reverts.
//
// Bold tag text, state-colored top border, minimal chrome — per the
// directive: "fast, visual, operational, low-friction" and "minimal
// text-heavy UI."

import React from "react";
import { MoreVertical, MapPin } from "lucide-react";
import type { Asset } from "@/lib/assets";
import { STATE_TONE, type EquipmentState } from "@/lib/whiteboard";

interface EquipmentTileProps {
  asset: Asset;
  /** Called on left-click of the tile body. Advances state. */
  onAdvance: (asset: Asset) => void;
  /** Called when the user wants to open the state menu (right-click,
   *  shift-click, or the ⋮ button). The parent positions and renders
   *  the menu via its own portal. */
  onPickState: (asset: Asset, anchor: { x: number; y: number }) => void;
}

// Tailwind class lookups for each tone. Kept inline so we don't pay
// the cost of dynamic class generation breaking purge.
const TONE_TOP_BAR: Record<string, string> = {
  slate:   "bg-slate-400",
  blue:    "bg-blue-500",
  amber:   "bg-amber-500",
  emerald: "bg-emerald-500",
  red:     "bg-red-500",
};

const TONE_BORDER: Record<string, string> = {
  slate:   "border-slate-200 hover:border-slate-300",
  blue:    "border-blue-200 hover:border-blue-300",
  amber:   "border-amber-200 hover:border-amber-300",
  emerald: "border-emerald-200 hover:border-emerald-300",
  red:     "border-red-300 hover:border-red-400",
};

export default function EquipmentTile({ asset, onAdvance, onPickState }: EquipmentTileProps) {
  const tone = STATE_TONE[asset.whiteboard_state as EquipmentState];
  const topBarClass = TONE_TOP_BAR[tone] ?? "bg-slate-300";
  const borderClass = TONE_BORDER[tone] ?? "border-slate-200";

  return (
    <div
      onClick={(e) => {
        // Shift-click opens the menu instead of advancing.
        if (e.shiftKey) {
          onPickState(asset, { x: e.clientX, y: e.clientY });
          return;
        }
        onAdvance(asset);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onPickState(asset, { x: e.clientX, y: e.clientY });
      }}
      className={`relative bg-white rounded-lg border ${borderClass} cursor-pointer transition-all hover:shadow-md select-none group`}
      title="Click to advance state · Right-click or Shift-click for menu"
    >
      {/* state color top bar */}
      <div className={`h-1.5 ${topBarClass} rounded-t-lg`} />

      <div className="p-2.5">
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <div className="font-mono font-black text-sm text-slate-900 truncate" title={asset.tag}>
              {asset.tag}
            </div>
            {asset.description && (
              <div className="mt-0.5 text-[11px] text-slate-600 truncate" title={asset.description}>
                {asset.description}
              </div>
            )}
            {asset.location && (
              <div className="mt-0.5 text-[10px] text-slate-500 inline-flex items-center gap-0.5 truncate">
                <MapPin className="w-2.5 h-2.5 shrink-0" />
                <span className="truncate">{asset.location}</span>
              </div>
            )}
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
              onPickState(asset, { x: rect.right, y: rect.bottom });
            }}
            className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-slate-700 p-0.5 rounded hover:bg-slate-100 transition-opacity"
            title="Pick state"
            aria-label="Pick state"
          >
            <MoreVertical className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
