"use client";

// "Everything inside": the full list behind a pillar. Short by default (the
// first few), the rest on demand, so the page stays short while the depth
// stays provable. Ink and paper only: chips are a list, not a signal.

import React, { useState } from "react";
import { ChevronDown } from "lucide-react";

export function ChipCloud({ chips, preview = 6 }: {
  chips: string[];
  preview?: number;
}) {
  const [open, setOpen] = useState(false);
  const shown = open ? chips : chips.slice(0, preview);
  return (
    <div className="flex flex-wrap gap-1.5">
      {shown.map((c, i) => (
        <span key={c}
          className="inline-flex items-center px-2 py-0.5 min-h-7 rounded-md bg-[var(--color-surface-2)] border border-[var(--color-border)] text-[13px] text-[var(--color-text)]"
          style={open && i >= preview ? { animation: `pop 0.3s var(--ease-fluid) ${Math.min((i - preview) * 18, 400)}ms both` } : undefined}>
          {c}
        </span>
      ))}
      {chips.length > preview && (
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
          className="inline-flex items-center gap-1 px-2.5 h-7 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[13px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] hover:border-[var(--color-text-faint)] transition-colors">
          {open ? "Show less" : `Show ${chips.length - preview} more`}
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      )}
    </div>
  );
}
