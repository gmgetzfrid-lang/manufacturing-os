"use client";

// SortRows — drag a report row (or a task's rows together) to a new place.
// Pointer events, so a finger on a tablet works the same as a mouse; the
// grip also takes ↑ ↓ from the keyboard. The order is read off the rows on
// screen (each marks itself with data-sort-id), so it's always the order
// the person sees.

import React, { useState } from "react";
import { GripVertical } from "lucide-react";

/** `ids` with `moving` taken out and put back before the `at`-th of the rest. */
export function moveIds(ids: string[], moving: string[], at: number): string[] {
  const mv = new Set(moving);
  const rest = ids.filter((x) => !mv.has(x));
  const block = ids.filter((x) => mv.has(x));
  const i = Math.max(0, Math.min(at, rest.length));
  return [...rest.slice(0, i), ...block, ...rest.slice(i)];
}

export function useSortRows(onReorder?: (ids: string[]) => void) {
  // The table's box (a callback ref: it's only read while dragging).
  const [box, setBox] = useState<HTMLElement | null>(null);
  const [drag, setDrag] = useState<{ moving: string[]; at: number; line: number } | null>(null);
  // The rows on screen, in order (the phone and desktop layouts both carry
  // the marks; only the one showing counts).
  const shown = () => [...(box?.querySelectorAll<HTMLElement>("[data-sort-id]") ?? [])].filter((n) => n.getClientRects().length > 0);
  const place = (moving: string[], y: number) => {
    const mv = new Set(moving);
    const rest = shown().filter((n) => !mv.has(n.dataset.sortId ?? ""));
    const at = rest.filter((n) => { const r = n.getBoundingClientRect(); return r.top + r.height / 2 < y; }).length;
    const top = box?.getBoundingClientRect().top ?? 0;
    const line = rest.length === 0 ? 0 : at < rest.length ? rest[at].getBoundingClientRect().top - top : rest[rest.length - 1].getBoundingClientRect().bottom - top;
    return { at, line };
  };
  const commit = (moving: string[], at: number) => {
    const ids = shown().map((n) => n.dataset.sortId ?? "");
    const next = moveIds(ids, moving, at);
    if (next.join("\u0000") !== ids.join("\u0000")) onReorder?.(next);
  };
  /** Props for a grip that moves `moving` (one row, or a task's rows). */
  const grip = (moving: string[], label: string) => (onReorder ? {
    role: "button" as const,
    tabIndex: 0,
    "aria-label": `Move ${label} — drag, or use the arrow keys`,
    title: "Drag to put it in a different place (or ↑ ↓)",
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      setDrag({ moving, ...place(moving, e.clientY) });
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      if (!drag) return;
      // Near the edge of the screen, keep going.
      if (e.clientY < 70) window.scrollBy(0, -18);
      else if (e.clientY > window.innerHeight - 70) window.scrollBy(0, 18);
      setDrag({ moving: drag.moving, ...place(drag.moving, e.clientY) });
    },
    onPointerUp: () => {
      if (!drag) return;
      const d = drag;
      setDrag(null);
      commit(d.moving, d.at);
    },
    onPointerCancel: () => setDrag(null),
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      const ids = shown().map((n) => n.dataset.sortId ?? "");
      const mv = new Set(moving);
      const first = ids.findIndex((x) => mv.has(x));
      if (first < 0) return;
      const before = ids.slice(0, first).filter((x) => !mv.has(x)).length;
      commit(moving, before + (e.key === "ArrowUp" ? -1 : 1));
    },
  } : null);
  const indicator = drag ? <div aria-hidden className="pointer-events-none absolute left-0 right-0 z-10 h-0.5 rounded bg-[var(--color-accent)]" style={{ top: drag.line - 1 }} /> : null;
  return { box: setBox, grip, indicator, moving: (id: string) => !!drag?.moving.includes(id) };
}

/** The grip itself: quiet until hovered, always there on touch. */
export function Grip({ props, className = "" }: { props: ReturnType<ReturnType<typeof useSortRows>["grip"]>; className?: string }) {
  if (!props) return null;
  return (
    <span {...props} style={{ touchAction: "none" }}
      className={`inline-flex items-center justify-center w-4 h-5 -ml-1 mr-0.5 align-middle rounded cursor-grab active:cursor-grabbing text-slate-400 opacity-40 group-hover/sort:opacity-100 pointer-coarse:opacity-100 hover:bg-slate-200/70 dark:hover:bg-slate-700/60 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-ring)] print:hidden ${className}`}>
      <GripVertical className="w-3 h-3.5" />
    </span>
  );
}
