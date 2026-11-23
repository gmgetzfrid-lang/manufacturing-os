"use client";

// A document's actions in one menu: what a right-click on a row opens, and
// what the row's "..." button opens. Purely presentational: the page decides
// which entries apply (single vs multi selection, controller vs member) and
// what they do. Drawn position:fixed at the pointer (or under the button) so
// it escapes any overflow container, kept on screen, closed on a click away,
// Escape or a scroll. Up and down walk it; the first entry has focus.

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
  // The keyboard lands in the menu.
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)")?.focus();
  }, []);
  const onMenuKey = (e: React.KeyboardEvent) => {
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const to = e.key === "ArrowDown" ? (i + 1) % items.length
      : e.key === "ArrowUp" ? (i - 1 + items.length) % items.length
      : e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    items[to]?.focus();
  };

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
        className="ui-float ui-float-in fixed z-[91] min-w-[220px] max-w-[300px] py-1 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl origin-top-left"
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={onMenuKey}
      >
        {entries.map((entry) => (
          <React.Fragment key={entry.key}>
            {entry.separator && <div className="my-1 border-t border-[var(--color-border)]" />}
            <button
              type="button"
              role="menuitem"
              disabled={entry.disabled}
              onClick={() => { onClose(); entry.onSelect(); }}
              className={`w-full flex items-center gap-2.5 px-3 min-h-10 pointer-coarse:min-h-11 text-left text-[14px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[var(--color-surface-2)] focus-visible:bg-[var(--color-surface-2)] ${
                entry.danger ? "text-[var(--state-overdue-text)]" : "text-[var(--color-text)]"
              }`}
            >
              <span className={`w-4 h-4 flex items-center justify-center shrink-0 [&>svg]:w-4 [&>svg]:h-4 ${entry.danger ? "" : "text-[var(--color-text-faint)]"}`}>{entry.icon}</span>
              <span className="truncate">{entry.label}</span>
            </button>
          </React.Fragment>
        ))}
      </div>
    </>
  );
}
