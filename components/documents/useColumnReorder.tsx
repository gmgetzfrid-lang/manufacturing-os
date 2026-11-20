"use client";

// Drag a table header to a new place, with pointer events (mouse, pen and
// touch alike). Native HTML5 drag is not used: it starts a text selection,
// leaves the table's rubber band selection armed on drop, and picks the
// drop target by whichever header the pointer happens to be over.
//
// How it reads:
//   * Press a header and move 5px: the header lifts into a ghost that
//     follows the pointer, and a line in the main color shows the gap the
//     column will drop into. The gap is the one nearest the pointer, so
//     the line, not the header under the pointer, says where it lands.
//   * Release: the column moves exactly to the line. Esc cancels.
//   * A press that never moves is a click (the header sorts as before).
//   * On a touch screen only the grip starts a drag, so a swipe on the
//     header row still scrolls the table sideways.
//   * Near the scroller's left or right edge the table scrolls along.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GripVertical } from "lucide-react";

const THRESHOLD = 5;
const EDGE = 48;

type Live = {
  key: string;
  pointerId: number;
  startX: number;
  startY: number;
  /** Where the pointer grabbed the header, from its top-left corner. */
  grabX: number;
  grabY: number;
  width: number;
  height: number;
  started: boolean;
  cancelled: boolean;
  x: number;
  y: number;
  /** Insertion gap: 0 = before the first column, n = after the last. */
  gap: number;
};

export type ColumnDragView = {
  key: string;
  label: string;
  x: number;
  y: number;
  grabX: number;
  grabY: number;
  width: number;
  height: number;
  lineX: number;
  lineTop: number;
  lineBottom: number;
  /** True when dropping here leaves the order as it is. */
  same: boolean;
};

/** Where the order ends up when `key` drops into `gap`. */
export function reorderToGap(order: string[], key: string, gap: number): string[] {
  const from = order.indexOf(key);
  if (from < 0) return order;
  if (gap === from || gap === from + 1) return order;
  const next = order.filter((k) => k !== key);
  next.splice(gap > from ? gap - 1 : gap, 0, key);
  return next;
}

export function useColumnReorder(opts: {
  columns: string[];
  labelFor: (key: string) => string;
  onReorder: (next: string[]) => void;
  /** The element that scrolls the table sideways (for auto-scroll and
   *  for the line's height). */
  scrollEl?: HTMLElement | null;
  disabled?: boolean;
}) {
  const { columns, labelFor, onReorder, scrollEl, disabled } = opts;
  const headers = useRef(new Map<string, HTMLElement>());
  const live = useRef<Live | null>(null);
  const suppressClick = useRef(false);
  const raf = useRef<number | null>(null);
  const [view, setView] = useState<ColumnDragView | null>(null);

  // Latest props for the window listeners (they're attached once per drag).
  const latest = useRef({ columns, labelFor, onReorder, scrollEl });
  useEffect(() => { latest.current = { columns, labelFor, onReorder, scrollEl }; });

  const register = useCallback((key: string) => (el: HTMLElement | null) => {
    if (el) headers.current.set(key, el);
    else headers.current.delete(key);
  }, []);

  /** Measure the headers now (the table may have scrolled) and find the
   *  gap nearest the pointer. */
  const measure = useCallback((x: number) => {
    const { columns: order } = latest.current;
    const rects = order.map((k) => headers.current.get(k)?.getBoundingClientRect() ?? null);
    const present = rects.filter((r): r is DOMRect => !!r);
    if (!present.length) return null;
    let gap = order.length;
    for (let i = 0; i < order.length; i++) {
      const r = rects[i];
      if (r && x < r.left + r.width / 2) { gap = i; break; }
    }
    const after = rects.slice(gap).find((r): r is DOMRect => !!r);
    const before = rects.slice(0, gap).reverse().find((r): r is DOMRect => !!r);
    const lineX = after ? after.left : before ? before.right : present[0].left;
    return { gap, lineX, top: present[0].top };
  }, []);

  const paint = useCallback(() => {
    const st = live.current;
    if (!st || !st.started || st.cancelled) { setView(null); return; }
    const m = measure(st.x);
    if (!m) return;
    st.gap = m.gap;
    const { columns: order, labelFor: lf, scrollEl: sc } = latest.current;
    const box = sc?.getBoundingClientRect();
    const from = order.indexOf(st.key);
    // Keep the line inside the visible part of the table.
    const left = box ? box.left + 1 : -Infinity;
    const right = box ? box.right - 2 : Infinity;
    setView({
      key: st.key,
      label: lf(st.key),
      x: st.x,
      y: st.y,
      grabX: st.grabX,
      grabY: st.grabY,
      width: st.width,
      height: st.height,
      lineX: Math.min(right, Math.max(left, m.lineX - 1)),
      lineTop: m.top,
      lineBottom: box ? Math.min(box.bottom, window.innerHeight) : m.top + 400,
      same: m.gap === from || m.gap === from + 1,
    });
  }, [measure]);

  // While the pointer rests near the scroller's edge, keep scrolling.
  const autoScroll = useCallback(() => {
    const step = () => {
      raf.current = null;
      const st = live.current;
      const sc = latest.current.scrollEl;
      if (!st || !st.started || st.cancelled || !sc) return;
      const box = sc.getBoundingClientRect();
      let dx = 0;
      if (st.x < box.left + EDGE) dx = -Math.ceil((box.left + EDGE - st.x) / 4);
      else if (st.x > box.right - EDGE) dx = Math.ceil((st.x - (box.right - EDGE)) / 4);
      if (!dx) return;
      const before = sc.scrollLeft;
      sc.scrollLeft += dx;
      if (sc.scrollLeft !== before) paint();
      raf.current = requestAnimationFrame(step);
    };
    if (raf.current == null) raf.current = requestAnimationFrame(step);
  }, [paint]);

  const end = useCallback((commit: boolean) => {
    const st = live.current;
    live.current = null;
    if (raf.current != null) { cancelAnimationFrame(raf.current); raf.current = null; }
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    document.body.style.webkitUserSelect = "";
    setView(null);
    if (!st || !st.started) return;
    // The release after a drag is not a click on the header.
    suppressClick.current = true;
    setTimeout(() => { suppressClick.current = false; }, 0);
    // Nothing selected behind the drag, ever.
    window.getSelection()?.removeAllRanges();
    if (!commit || st.cancelled) return;
    const order = latest.current.columns;
    const next = reorderToGap(order, st.key, st.gap);
    if (next !== order) latest.current.onReorder(next);
  }, []);

  useEffect(() => () => {
    if (raf.current != null) cancelAnimationFrame(raf.current);
  }, []);

  const onPointerDown = useCallback((key: string) => (e: React.PointerEvent<HTMLElement>) => {
    if (disabled || e.button !== 0 || live.current) return;
    const t = e.target as HTMLElement;
    // The resize handle and any control inside the header keep their own job.
    if (t.closest("[data-col-resize], button, input, a, select, textarea")) return;
    // On touch, only the grip drags; the rest of the header row scrolls.
    if (e.pointerType === "touch" && !t.closest("[data-col-grip]")) return;
    // No text selection, no rubber band, no native drag from this press.
    e.preventDefault();
    const th = headers.current.get(key) ?? (e.currentTarget as HTMLElement);
    const r = th.getBoundingClientRect();
    live.current = {
      key, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY,
      grabX: e.clientX - r.left, grabY: e.clientY - r.top,
      width: r.width, height: r.height,
      started: false, cancelled: false, x: e.clientX, y: e.clientY, gap: -1,
    };

    const onMove = (ev: PointerEvent) => {
      const st = live.current;
      if (!st || ev.pointerId !== st.pointerId) return;
      st.x = ev.clientX; st.y = ev.clientY;
      if (!st.started) {
        if (Math.abs(ev.clientX - st.startX) < THRESHOLD && Math.abs(ev.clientY - st.startY) < THRESHOLD) return;
        st.started = true;
        document.body.style.cursor = "grabbing";
        document.body.style.userSelect = "none";
        document.body.style.webkitUserSelect = "none";
        window.getSelection()?.removeAllRanges();
      }
      if (st.cancelled) return;
      ev.preventDefault();
      paint();
      autoScroll();
    };
    const onUp = (ev: PointerEvent) => {
      if (live.current && ev.pointerId !== live.current.pointerId) return;
      detach();
      end(ev.type === "pointerup");
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || !live.current) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (live.current.started) {
        // Cancelled: the overlay goes now; the release that follows does nothing.
        live.current.cancelled = true;
        setView(null);
        document.body.style.cursor = "";
      } else {
        detach();
        end(false);
      }
    };
    const onBlur = () => { detach(); end(false); };
    // A drag never starts a text selection, wherever the pointer wanders.
    const onSelectStart = (ev: Event) => { if (live.current?.started) ev.preventDefault(); };
    const detach = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("selectstart", onSelectStart, true);
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    document.addEventListener("selectstart", onSelectStart, true);
  }, [disabled, paint, autoScroll, end]);

  /** Call first thing in the header's onClick: true means the click was the
   *  end of a drag and must not sort. */
  const consumeClick = useCallback(() => suppressClick.current, []);

  const overlay = view && typeof document !== "undefined" ? createPortal(
    <>
      {/* Where it will land: a line in the gap, with a cap on the header row. */}
      <div
        aria-hidden
        className="pointer-events-none fixed z-[95] w-[3px] rounded-full bg-[var(--color-main)] shadow-[0_0_0_1px_var(--color-surface)]"
        style={{ left: view.lineX - 1, top: view.lineTop, height: Math.max(0, view.lineBottom - view.lineTop), opacity: view.same ? 0.35 : 1 }}
      />
      <div
        aria-hidden
        className="pointer-events-none fixed z-[95] w-[11px] h-[11px] rounded-full bg-[var(--color-main)] border-2 border-[var(--color-surface)]"
        style={{ left: view.lineX - 5, top: view.lineTop - 5, opacity: view.same ? 0.35 : 1 }}
      />
      {/* The header, lifted, following the pointer. */}
      <div
        aria-hidden
        className="pointer-events-none fixed z-[96] flex items-center gap-1.5 pl-1.5 pr-3 rounded-md border border-[var(--color-main)] bg-[var(--color-surface)] text-[13px] font-semibold text-[var(--color-text)] shadow-xl select-none"
        style={{
          left: view.x - Math.min(view.grabX, Math.min(view.width, 260) - 12),
          top: view.y - view.grabY,
          width: Math.min(view.width, 260),
          height: view.height,
        }}
      >
        <GripVertical className="w-3.5 h-3.5 shrink-0 text-[var(--color-main)]" />
        <span className="truncate">{view.label}</span>
      </div>
      <div role="status" aria-live="polite" className="sr-only">
        Moving {view.label}. Release to drop it at the line, Esc to cancel.
      </div>
    </>,
    document.body,
  ) : null;

  return {
    /** The column being dragged (dim its header and cells), or null. */
    draggingKey: view?.key ?? null,
    register,
    onPointerDown,
    consumeClick,
    overlay,
  };
}
