"use client";

// ProgressControl — set a LEAF task's physical % complete.
//
// Two shapes share one slider:
//   <ProgressSlider/>  — the inline control (detail panel): a 0–100 slider plus
//                        0/25/50/75/Done quick buttons.
//   <ProgressControl/> — a compact "62%" chip (timeline rows, calendar tiles)
//                        that opens the slider in a portal popover.
//
// Summary/parent tasks never use this — their % is rolled up from children
// (see lib/scheduleProgress.ts), so callers render it read-only there.

import React, { useRef, useState } from "react";
import { createPortal } from "react-dom";

function clamp(p: number): number {
  return Math.max(0, Math.min(100, Math.round(p || 0)));
}

const QUICK = [0, 25, 50, 75, 100];

interface SliderProps {
  percent: number;
  onPick: (percent: number) => void;
  disabled?: boolean;
  busy?: boolean;
}

export function ProgressSlider({ percent, onPick, disabled, busy }: SliderProps) {
  const target = clamp(percent);
  const [val, setVal] = useState(target);
  const [synced, setSynced] = useState(target);
  const [dragging, setDragging] = useState(false);
  // Track external changes (optimistic updates, refetches) unless the user is
  // mid-drag — we don't want the thumb to jump while they're dragging. Adjusting
  // during render (not in an effect) is React's recommended pattern for this.
  if (!dragging && target !== synced) {
    setSynced(target);
    setVal(target);
  }

  const commit = (v: number) => {
    const c = clamp(v);
    setDragging(false);
    setVal(c);
    if (c !== clamp(percent)) onPick(c);
  };

  return (
    <div className="w-full">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">Progress</span>
        <span className="text-sm font-black text-[var(--color-text)] tabular-nums">{val}%</span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={val}
        disabled={disabled || busy}
        onPointerDown={() => setDragging(true)}
        onChange={(e) => setVal(Number(e.target.value))}
        onPointerUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
        className="w-full accent-[var(--color-accent)] cursor-pointer disabled:opacity-50"
        aria-label="Percent complete"
      />
      <div className="mt-2 flex items-center gap-1">
        {QUICK.map((q) => (
          <button
            key={q}
            type="button"
            disabled={disabled || busy}
            onClick={() => commit(q)}
            className={`flex-1 text-[11px] font-bold py-1 rounded-md border transition-colors disabled:opacity-50 ${
              val === q
                ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] border-[var(--color-accent)]"
                : "bg-[var(--color-surface)] text-[var(--color-text-muted)] border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"
            }`}
          >
            {q === 100 ? "Done" : `${q}%`}
          </button>
        ))}
      </div>
    </div>
  );
}

interface ChipProps extends SliderProps {
  onDisabledClick?: () => void;
  size?: "sm" | "md";
}

export default function ProgressControl({ percent, onPick, disabled, onDisabledClick, busy, size = "md" }: ChipProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const pct = clamp(percent);

  const openMenu = () => {
    if (disabled) { onDisabledClick?.(); return; }
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - 240)) });
    }
    setOpen((v) => !v);
  };

  const tone = pct >= 100
    ? "text-emerald-700 bg-emerald-50 border-emerald-200"
    : pct > 0
      ? "text-blue-700 bg-blue-50 border-blue-200"
      : "text-[var(--color-text-muted)] bg-[var(--color-surface-2)] border-[var(--color-border)]";

  return (
    <>
      <button
        ref={btnRef}
        onClick={(e) => { e.stopPropagation(); openMenu(); }}
        title={disabled ? `${pct}% complete` : `${pct}% complete — click to set`}
        className={`inline-flex items-center justify-center rounded-md border font-bold tabular-nums ${
          size === "sm" ? "px-1 py-0 text-[9px]" : "px-1.5 py-0.5 text-[10px]"
        } ${tone} ${disabled ? "cursor-default opacity-80" : "cursor-pointer hover:brightness-95"}`}
      >
        {pct}%
      </button>

      {open && typeof document !== "undefined" && createPortal(
        <>
          <div className="fixed inset-0 z-[300]" onClick={() => setOpen(false)} />
          <div
            className="fixed z-[310] w-[224px] bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border)] ring-1 ring-black/5 rounded-xl shadow-lg p-3 animate-in fade-in zoom-in-95 duration-150"
            style={{ top: pos.top, left: pos.left }}
            onClick={(e) => e.stopPropagation()}
          >
            <ProgressSlider percent={pct} onPick={onPick} busy={busy} />
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
