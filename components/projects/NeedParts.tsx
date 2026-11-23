"use client";

// The small parts every requirement on a project is shown with: the quiet
// line saying where it came from (lib/requirementSource), an on/off switch,
// and a two-way Needed / Not needed choice.

import React from "react";
import { Check } from "lucide-react";
import { sourceWords, type Source } from "@/lib/requirementSource";
import { bandSeg, bandSegItem } from "@/components/admin/band";

/** "App default: each phase needs its own PSSR" / "Set for this project (Nov 23 by eng)". */
export function SourceLine({ source, tz, className = "" }: { source: Source; tz: string; className?: string }) {
  return <span className={`block text-[13px] leading-snug text-[var(--color-text-muted)] ${className}`} data-source={source.kind}>{sourceWords(source, tz)}</span>;
}

/** An on/off switch (a turnover document required for this job). */
export function Switch({ on, label, disabled, onChange }: { on: boolean; label: string; disabled?: boolean; onChange: () => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={onChange}
      className="shrink-0 inline-flex items-center justify-center w-11 h-9 -mx-1 disabled:opacity-60">
      <span className={`relative w-9 h-5 rounded-full transition-colors ${on ? "bg-[var(--color-main)]" : "bg-[var(--color-border-strong)]"}`}>
        <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-[var(--color-surface)] shadow transition-all ${on ? "left-[18px]" : "left-0.5"}`} />
      </span>
    </button>
  );
}

/** Needed / Not needed, for this project. */
export function NeededChoice({ needed, what, disabled, onChange }: { needed: boolean; what: string; disabled?: boolean; onChange: (needed: boolean) => void }) {
  return (
    <span className={bandSeg} role="radiogroup" aria-label={`${what}: needed for this project?`}>
      {[true, false].map((v) => (
        <button key={String(v)} type="button" role="radio" aria-checked={needed === v} disabled={disabled}
          onClick={() => { if (needed !== v) onChange(v); }} className={`${bandSegItem(needed === v)} disabled:opacity-60`}>
          {needed === v && <Check className="w-3.5 h-3.5" />}{v ? "Needed" : "Not needed"}
        </button>
      ))}
    </span>
  );
}
