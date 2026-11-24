"use client";

// Pick a crew from every crew on the schedule — a menu, not a typed box
// (a typed box with suggestions only ever offers names like what's already
// in it). "Other…" is for a crew that isn't on the schedule yet.

import React, { useState } from "react";

const OTHER = "\u0000other";

export default function CrewPicker({ value, onChange, crews, className = "", label = "Crew", disabled }: {
  value: string;
  onChange: (crew: string) => void;
  /** Every crew on the schedule. */
  crews: string[];
  className?: string;
  label?: string;
  disabled?: boolean;
}) {
  const list = [...new Set([...crews, ...(value.trim() ? [value.trim()] : [])])].sort((a, b) => a.localeCompare(b));
  const [typing, setTyping] = useState(false);
  if (typing) {
    return (
      <span className={`inline-flex items-center gap-1 ${className}`}>
        <input autoFocus value={value} onChange={(e) => onChange(e.target.value)} placeholder="New crew name" aria-label={label} disabled={disabled}
          className="h-8 pointer-coarse:h-11 min-w-0 flex-1 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-caption text-[var(--color-text)]" />
        <button type="button" onClick={() => setTyping(false)} className="inline-flex items-center justify-center gap-1.5 h-8 pointer-coarse:h-11 px-3 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-colors">List</button>
      </span>
    );
  }
  return (
    <select value={value.trim()} aria-label={label} disabled={disabled}
      onChange={(e) => { if (e.target.value === OTHER) { setTyping(true); onChange(""); } else onChange(e.target.value); }}
      className={`h-8 pointer-coarse:h-11 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-1.5 text-caption text-[var(--color-text)] ${className}`}>
      <option value="">- Crew -</option>
      {list.map((c) => <option key={c} value={c}>{c}</option>)}
      <option value={OTHER}>Other…</option>
    </select>
  );
}
