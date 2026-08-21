"use client";

// Right-click context menu for document rows/cards — the Explorer staple the
// table never had. Purely presentational: the page decides which entries
// apply (single vs multi selection, controller vs member) and what they do.
// Rendered position:fixed at the cursor so it escapes any overflow container,
// clamped to the viewport, closed on click-away / Escape / scroll.

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface ContextMenuEntry {
  key: string;
  label: string;
  icon?: React.ReactNode;
  /** Renders red — destructive actions. */
  danger?: boolean;
  disabled?: boolean;
  /** A thin rule ABOVE this entry, grouping what follows. */
  separator?: boolean;
  onSelect: () => void;
}

export default function DocContextMenu({
  x,
  y,
  entries,
  onClose,
}: {
  x: number;
  y: number;
  entries: ContextMenuEntry[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Clamp to the viewport once we know the menu's real size.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)),
    });
  }, [x, y, entries.length]);

  useEffect(() => {
    // Escape must not leak to the page (it would also clear the selection
    // the menu is acting on) — capture phase, stopPropagation.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    };
    // Close on any press OUTSIDE the menu — capture phase, no overlay div.
    // This lets a right-click on ANOTHER row close this menu and still reach
    // the row, which reopens the menu there in one gesture (Explorer's
    // behavior; an overlay needed two clicks).
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onScroll = () => onClose();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [onClose]);

  return (
    <>
      <div
        ref={ref}
        role="menu"
        style={{ left: pos.left, top: pos.top }}
        className="fixed z-[91] min-w-[220px] max-w-[300px] py-1.5 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl shadow-xl"
        onContextMenu={(e) => e.preventDefault()}
      >
        {entries.map((entry) => (
          <React.Fragment key={entry.key}>
            {entry.separator && <div className="my-1.5 border-t border-[var(--color-border)]" />}
            <button
              type="button"
              role="menuitem"
              disabled={entry.disabled}
              onClick={() => { onClose(); entry.onSelect(); }}
              className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-xs font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                entry.danger
                  ? "text-red-600 hover:bg-red-50"
                  : "text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
              }`}
            >
              <span className="w-4 h-4 flex items-center justify-center shrink-0">{entry.icon}</span>
              <span className="truncate">{entry.label}</span>
            </button>
          </React.Fragment>
        ))}
      </div>
    </>
  );
}
