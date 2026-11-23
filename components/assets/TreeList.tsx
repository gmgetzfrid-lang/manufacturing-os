"use client";

// TreeList: nested rows you can read four levels deep and drive from the
// keyboard (units > equipment types > equipment). Each level steps 16 px to
// the right and a thin guide line drops from every open row, so you follow
// the line instead of counting gaps; the line of the branch you're in is
// darker. One chevron turns a quarter circle to open (the icon never
// swaps). Arrow keys: down and up move, right opens (or steps into the
// first child), left closes (or steps out to the parent), Home and End jump,
// Enter does the row's job. A row whose children are still being built
// shows skeleton rows in their place while the rest stays usable.
//
// The caller passes the rows that are visible now (already flattened, in
// order) and keeps which ones are open.

import React, { useCallback, useMemo, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Skeleton } from "@/components/ui/Skeleton";

export interface TreeRow {
  key: string;
  /** 0 for the top level. */
  level: number;
  /** Keys of the rows above this one, outermost first. */
  ancestors: string[];
  /** Has children (shows a chevron). */
  expandable?: boolean;
  open?: boolean;
  /** Its children are still being built: skeleton rows sit under it. */
  pending?: number;
  /** A 3 px edge in a state color: the row needs someone. */
  edge?: "warn" | "bad";
  /** What the row is, for screen readers ("Crude Unit, 155 pieces"). */
  label: string;
  /** Enter or a click on the row. Without it, a click opens or closes. */
  onActivate?: () => void;
  /** The row's cells after the chevron (laid out by `grid`). The first
   *  cell sits after the indent. */
  cells: React.ReactNode;
  /** Extra classes on the row (a muted "show more" row). */
  className?: string;
}

const STEP = 16;
const PAD = 16;

export default function TreeList({
  rows, onToggle, grid, head, ariaLabel, className = "",
}: {
  rows: TreeRow[];
  onToggle: (key: string, open: boolean) => void;
  /** Grid columns for every row, e.g. "grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[…]". */
  grid: string;
  /** Column headings (shown from 640 px), as grid cells in the same columns. */
  head?: React.ReactNode;
  ariaLabel: string;
  className?: string;
}) {
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const refs = useRef(new Map<string, HTMLDivElement>());
  const index = useMemo(() => new Map(rows.map((r, i) => [r.key, i])), [rows]);
  // The row that takes Tab: the focused one, else the first.
  const tabKey = focusKey && index.has(focusKey) ? focusKey : rows[0]?.key ?? null;
  const focusedRow = tabKey ? rows[index.get(tabKey) ?? 0] : null;
  const branch = useMemo(() => new Set(focusedRow ? [...focusedRow.ancestors, focusedRow.key] : []), [focusedRow]);

  const moveTo = useCallback((key: string | undefined) => {
    if (!key) return;
    setFocusKey(key);
    refs.current.get(key)?.focus();
  }, []);

  const onKey = (e: React.KeyboardEvent, r: TreeRow) => {
    // Keys typed inside a button or field in the row belong to it (the
    // chevron is part of the row itself).
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).dataset?.chevron) return;
    const i = index.get(r.key) ?? 0;
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); moveTo(rows[Math.min(rows.length - 1, i + 1)]?.key); break;
      case "ArrowUp": e.preventDefault(); moveTo(rows[Math.max(0, i - 1)]?.key); break;
      case "Home": e.preventDefault(); moveTo(rows[0]?.key); break;
      case "End": e.preventDefault(); moveTo(rows[rows.length - 1]?.key); break;
      case "ArrowRight":
        e.preventDefault();
        if (r.expandable && !r.open) onToggle(r.key, true);
        else if (r.expandable && r.open && rows[i + 1]?.level === r.level + 1) moveTo(rows[i + 1].key);
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (r.expandable && r.open) onToggle(r.key, false);
        else if (r.ancestors.length > 0) moveTo(r.ancestors[r.ancestors.length - 1]);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (r.onActivate) r.onActivate();
        else if (r.expandable) onToggle(r.key, !r.open);
        break;
    }
  };

  const guides = (r: TreeRow) => r.ancestors.map((a, lvl) => (
    <span key={a} aria-hidden className="absolute top-0 bottom-0 w-px"
      style={{ left: PAD + lvl * STEP + 7, background: branch.has(a) ? "var(--color-text-faint)" : "var(--color-border)" }} />
  ));

  return (
    <div className={`rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden ${className}`}>
      {head && (
        <div aria-hidden className={`grid ${grid} items-center gap-x-4 h-10 pr-4 bg-[var(--color-surface-2)] text-[13px] font-semibold text-[var(--color-text-muted)] max-sm:hidden`}
          style={{ paddingLeft: PAD + STEP + 8 }}>
          {head}
        </div>
      )}
      <div role="tree" aria-label={ariaLabel} className="divide-y divide-[var(--color-border)]">
        {rows.map((r) => {
          const indent = PAD + r.level * STEP;
          return (
            <React.Fragment key={r.key}>
              <div
                ref={(el) => { if (el) refs.current.set(r.key, el); else refs.current.delete(r.key); }}
                role="treeitem"
                aria-level={r.level + 1}
                aria-selected={r.key === tabKey}
                aria-expanded={r.expandable ? !!r.open : undefined}
                aria-label={r.label}
                tabIndex={r.key === tabKey ? 0 : -1}
                onFocus={(e) => { if (e.target === e.currentTarget) setFocusKey(r.key); }}
                onKeyDown={(e) => onKey(e, r)}
                onClick={() => {
                  setFocusKey(r.key);
                  if (r.onActivate) r.onActivate();
                  else if (r.expandable) onToggle(r.key, !r.open);
                }}
                className={`relative grid ${grid} items-center gap-x-4 min-h-12 py-2 pr-4 cursor-pointer hover:bg-[var(--color-surface-2)] transition-colors [outline-offset:-2px] ${r.className ?? ""}`}
                style={{ paddingLeft: indent }}
              >
                {r.edge && <span aria-hidden className="absolute left-0 inset-y-0 w-[3px]" style={{ background: r.edge === "bad" ? "var(--state-overdue)" : "var(--state-held)" }} />}
                {guides(r)}
                {/* The chevron sits in the indent; the first cell starts after it. */}
                <span className="absolute top-1/2 -translate-y-1/2" style={{ left: indent }}>
                  {r.expandable ? (
                    <button type="button" tabIndex={-1} aria-hidden data-chevron="1"
                      // The row keeps the focus (and its ring), not the chevron.
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={(e) => { e.stopPropagation(); moveTo(r.key); onToggle(r.key, !r.open); }}
                      className="-m-1.5 p-1.5 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)]">
                      <ChevronRight className={`ui-chevron w-4 h-4 ${r.open ? "rotate-90" : ""}`} />
                    </button>
                  ) : null}
                </span>
                {/* Leave the chevron's width before the first cell. */}
                <div className="contents [&>*:first-child]:ml-6">{r.cells}</div>
              </div>
              {r.open && (r.pending ?? 0) > 0 && (
                <div role="status" aria-live="polite" className="divide-y divide-[var(--color-border)]">
                  <span className="sr-only">Loading</span>
                  {Array.from({ length: Math.min(r.pending ?? 0, 4) }, (_, k) => (
                    <div key={k} className="relative flex items-center gap-4 h-12 pr-4" style={{ paddingLeft: PAD + (r.level + 1) * STEP + 24 }}>
                      {[...r.ancestors, r.key].map((a, lvl) => (
                        <span key={a} aria-hidden className="absolute top-0 bottom-0 w-px" style={{ left: PAD + lvl * STEP + 7, background: "var(--color-border)" }} />
                      ))}
                      <Skeleton className="h-3.5" style={{ width: `${[38, 52, 30, 44][k]}%` }} />
                    </div>
                  ))}
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
