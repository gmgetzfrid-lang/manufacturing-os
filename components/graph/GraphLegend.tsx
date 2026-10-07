"use client";

// GraphLegend — the map's key (GPV-8 / GPV-14).
//
// Ten edge colours and seven node colours were painted with no key, and the
// path accent was a near twin of the flow colour. The legend is built from
// the same tables the renderers draw with (components/graph/graphTheme.ts),
// so it cannot drift from the map: each edge kind with its colour, an arrow
// where direction is the meaning, the three library statements a unit can
// make (filed, pinned, bound) and the three kinds of unit node.

import React from "react";
import { KeyRound, X } from "lucide-react";
import type { GraphNodeType } from "@/lib/orgGraph";
import {
  EDGE_LEGEND, NODE_COLORS, UNIT_VARIANT_COLORS, UNIT_VARIANT_LABELS, type UnitVariant,
} from "@/components/graph/graphTheme";

const NODE_LEGEND: Array<{ type: GraphNodeType; label: string }> = [
  { type: "asset", label: "Equipment" },
  { type: "document", label: "Document" },
  { type: "library", label: "Library" },
  { type: "project", label: "Project" },
  { type: "plant", label: "Plant" },
  { type: "plot", label: "Plot plan" },
];

export default function GraphLegend({ arrowsOn, mode }: { arrowsOn: boolean; mode: "2d" | "3d" }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="absolute bottom-10 left-3 z-10 flex flex-col items-start gap-1.5">
      {open && (
        <div role="region" aria-label="Map legend"
          className="w-64 max-w-[calc(100vw-1.5rem)] max-h-[50vh] overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]/97 backdrop-blur shadow-2xl p-2.5 space-y-2">
          <div className="flex items-center gap-1.5">
            <KeyRound className="w-3.5 h-3.5 text-violet-600" />
            <span className="flex-1 text-[10px] font-black uppercase tracking-widest text-[var(--color-text)]">Legend</span>
            <button onClick={() => setOpen(false)} aria-label="Close legend"
              className="text-[var(--color-text-faint)] hover:text-[var(--color-text)]"><X className="w-3.5 h-3.5" /></button>
          </div>
          <div className="space-y-0.5">
            <div className="text-[9px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">Links</div>
            {EDGE_LEGEND.map((l) => (
              <div key={l.key} className="flex items-center gap-1.5 text-[10px] text-[var(--color-text)]">
                <svg width="26" height="8" aria-hidden="true" className="shrink-0">
                  <line x1="1" y1="4" x2={l.arrow ? 19 : 25} y2="4" stroke={`rgb(${l.rgb})`} strokeWidth="2"
                    strokeDasharray={l.dashed ? "4 3" : undefined} />
                  {l.arrow && <polygon points="18,0 26,4 18,8" fill={`rgb(${l.rgb})`} />}
                </svg>
                <span className="flex-1">{l.label}</span>
              </div>
            ))}
            <div className="text-[9px] text-[var(--color-text-faint)] leading-snug pt-0.5">
              {arrowsOn
                ? "An arrow points from what feeds to what is fed, and from the replaced revision to its replacement."
                : "Arrows are off — Settings → Display → Arrows shows which way flows and supersession run."}
              {" "}Library links show with Settings → Library links.
              {mode === "3d" && " In 3D an arrow is a cone at the far end."}
            </div>
          </div>
          <div className="space-y-0.5">
            <div className="text-[9px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">Nodes</div>
            {(["codebook", "operational", "system"] as UnitVariant[]).map((v) => (
              <div key={v} className="flex items-center gap-1.5 text-[10px] text-[var(--color-text)]">
                <span className={`w-2.5 h-2.5 shrink-0 ${v === "system" ? "" : "rounded-full"}`}
                  style={v === "operational"
                    ? { border: `2px solid ${UNIT_VARIANT_COLORS[v]}` }
                    : { backgroundColor: UNIT_VARIANT_COLORS[v] }} />
                <span className="flex-1">{UNIT_VARIANT_LABELS[v]}</span>
              </div>
            ))}
            {NODE_LEGEND.map((n) => (
              <div key={n.type} className="flex items-center gap-1.5 text-[10px] text-[var(--color-text)]">
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: NODE_COLORS[n.type] }} />
                <span className="flex-1">{n.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open}
        className={`inline-flex items-center gap-1 px-2 py-1 rounded-full border text-[10px] font-black shadow-sm ${
          open ? "border-violet-400 text-violet-700 bg-[var(--color-surface)]"
               : "border-[var(--color-border-strong)] text-[var(--color-text-muted)] bg-[var(--color-surface)]/90 backdrop-blur"
        }`}>
        <KeyRound className="w-3 h-3" /> Legend
      </button>
    </div>
  );
}
