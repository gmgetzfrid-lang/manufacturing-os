"use client";

// PctSlider: the % done. Slide it, or nudge it a point at a time with − / +.
// Shows what it was; 100% is finished.

import React from "react";

/** The % done: slide it, or nudge it a point at a time. 100% is finished. */
export default function PctSlider({ value, was, onChange, disabled }: { value: number; was: number; onChange: (v: number) => void; disabled?: boolean }) {
  const set = (v: number) => onChange(Math.max(0, Math.min(100, Math.round(v))));
  const nudge = "ui-hit w-9 h-9 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-section font-semibold leading-none text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-40";
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <button type="button" aria-label="1% less" disabled={disabled || value <= 0} onClick={() => set(value - 1)} className={nudge}>−</button>
        <span className="w-14 text-center text-reading font-medium tabular-nums">{value}%</span>
        <button type="button" aria-label="1% more" disabled={disabled || value >= 100} onClick={() => set(value + 1)} className={nudge}>+</button>
        <span className="text-caption text-[var(--color-text-muted)]">{value === was ? "slide to the new %" : value === 100 ? `was ${was}%, finished` : `was ${was}%`}</span>
      </div>
      <input type="range" min={0} max={100} step={1} value={value} onChange={(e) => set(Number(e.target.value))} aria-label="Percent done" disabled={disabled}
        className="w-full h-8 cursor-pointer accent-[var(--color-text)]" />
    </div>
  );
}
