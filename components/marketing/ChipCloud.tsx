"use client";

// "Everything inside" — the completeness receipt for a pillar section.
// Concise by default (first row of chips), full blow-out on demand. This is
// how the page stays short while still proving the depth is real.

import React, { useState } from "react";
import { ChevronDown, Check } from "lucide-react";

export function ChipCloud({ chips, accent = "orange", preview = 6 }: {
  chips: string[];
  /** tailwind hue family for the chips: orange | violet | emerald | cyan | blue | rose */
  accent?: string;
  preview?: number;
}) {
  const [open, setOpen] = useState(false);
  const shown = open ? chips : chips.slice(0, preview);
  const tone: Record<string, string> = {
    orange: "bg-orange-50 border-orange-200 text-orange-900",
    violet: "bg-violet-50 border-violet-200 text-violet-900",
    emerald: "bg-emerald-50 border-emerald-200 text-emerald-900",
    cyan: "bg-cyan-50 border-cyan-200 text-cyan-900",
    blue: "bg-blue-50 border-blue-200 text-blue-900",
    rose: "bg-rose-50 border-rose-200 text-rose-900",
  };
  const cls = tone[accent] ?? tone.orange;
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {shown.map((c, i) => (
          <span key={c}
            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-[11px] font-bold ${cls}`}
            style={open ? { animation: `pop 0.3s var(--ease-fluid) ${Math.min(i * 18, 400)}ms both` } : undefined}>
            <Check className="w-3 h-3 opacity-60" /> {c}
          </span>
        ))}
        {chips.length > preview && (
          <button type="button" onClick={() => setOpen((v) => !v)}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-slate-300 bg-white text-[11px] font-black text-slate-700 hover:border-slate-500 transition-colors">
            {open ? "Show less" : `+ ${chips.length - preview} more`}
            <ChevronDown className={`w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
        )}
      </div>
    </div>
  );
}
