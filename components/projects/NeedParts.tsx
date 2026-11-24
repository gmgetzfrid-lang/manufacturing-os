"use client";

// The small parts every requirement on a project is shown with: the quiet
// line saying where it came from (lib/requirementSource), an on/off switch,
// and a two-way Needed / Not needed choice.

import React from "react";
import { sourceWords, type Source } from "@/lib/requirementSource";

/** "App default: each phase needs its own PSSR" / "Set for this project (Nov 23 by eng)". */
export function SourceLine({ source, tz, className = "" }: { source: Source; tz: string; className?: string }) {
  return <span className={`block text-body leading-snug text-[var(--color-text-muted)] ${className}`} data-source={source.kind}>{sourceWords(source, tz)}</span>;
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

/** Needed / Not needed, for this project: two plain radio buttons (the
 *  one picked is a filled dot), not a filled toggle. */
export function NeededChoice({ needed, what, disabled, onChange }: { needed: boolean; what: string; disabled?: boolean; onChange: (needed: boolean) => void }) {
  const name = React.useId();
  return (
    <span className="inline-flex items-center gap-4" role="radiogroup" aria-label={`${what}: needed for this project?`}>
      {[true, false].map((v) => (
        <label key={String(v)} className={`inline-flex items-center gap-2 min-h-9 pointer-coarse:min-h-11 text-body cursor-pointer select-none ${disabled ? "opacity-60 cursor-not-allowed" : ""} ${needed === v ? "text-[var(--color-text)] font-medium" : "text-[var(--color-text-muted)]"}`}>
          <input type="radio" name={name} checked={needed === v} disabled={disabled}
            onChange={() => { if (needed !== v) onChange(v); }}
            className="w-4 h-4 accent-[var(--color-current)] cursor-pointer disabled:cursor-not-allowed" />
          {v ? "Needed" : "Not needed"}
        </label>
      ))}
    </span>
  );
}
