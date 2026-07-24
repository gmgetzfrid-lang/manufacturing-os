// useViewerPanZoom — shared "operate like a normal PDF viewer" gestures for the
// scroll-stack viewers (collection book, file-reference modal, etc.):
//   - Ctrl + mouse-wheel  → zoom (and we preventDefault the browser page-zoom)
//   - Grab-hand drag       → pan the page (drag-to-scroll the container)
//   - A cursor toggle       → leave pan mode so normal clicks/markup work
//
// The host owns the actual zoom model (react-pdf re-renders at a new width); this
// hook just turns ctrl-wheel into zoom-direction callbacks and drag into scroll.

import { useCallback, useEffect, useRef, useState } from "react";

export function useViewerPanZoom(opts: {
  containerRef: React.RefObject<HTMLElement | null>;
  /** Called with a multiplicative zoom factor (>1 zoom in, <1 zoom out) already
   *  smoothed + throttled to one update per animation frame. The host clamps and
   *  applies it (e.g. setZoom(z => clamp(z * factor))). */
  onZoom: (factor: number) => void;
  /** Pan is only active when this is true (e.g. disable while marking up). */
  enabled?: boolean;
  /** Keep the point under the cursor pinned while zooming by adjusting the
   *  container's scroll. True for the scroll-stack viewers; set false for hosts
   *  that center/translate their own content (e.g. the markup editor). */
  anchorZoom?: boolean;
}) {
  const { containerRef, onZoom, enabled = true, anchorZoom = true } = opts;
  const [panMode, setPanMode] = useState(true);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);
  const onZoomRef = useRef(onZoom);
  useEffect(() => { onZoomRef.current = onZoom; });

  // Ctrl+wheel zoom. Native non-passive listener so preventDefault suppresses the
  // browser's own page zoom. Wheel deltas are ACCUMULATED and flushed once per
  // animation frame as a single PROPORTIONAL factor — so a fast scroll or a
  // high-resolution trackpad produces one smooth zoom step per frame instead of a
  // burst of fixed jumps that each re-rasterize the PDF (the old "atrocious" feel).
  // The point under the cursor stays pinned (cursor-anchored zoom, like Chrome/
  // Acrobat): fx/fy are fractions of the scroll content and are scale-INVARIANT,
  // so re-applying them after the async re-raster keeps that point fixed.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let accum = 0;
    let raf = 0;
    let reRaf = 0;
    let anchor: { fx: number; fy: number; ox: number; oy: number } | null = null;
    const applyAnchor = () => {
      if (!anchor) return;
      el.scrollLeft = anchor.fx * el.scrollWidth - anchor.ox;
      el.scrollTop = anchor.fy * el.scrollHeight - anchor.oy;
    };
    const scheduleReanchor = () => {
      if (!anchorZoom || !anchor) return;
      let n = 0;
      if (reRaf) cancelAnimationFrame(reRaf);
      const step = () => { applyAnchor(); reRaf = ++n < 6 ? requestAnimationFrame(step) : 0; };
      reRaf = requestAnimationFrame(step);
    };
    const flush = () => {
      raf = 0;
      const d = accum;
      accum = 0;
      if (d === 0) return;
      // ~12% per typical wheel notch (deltaY≈100); accumulated deltas compound.
      onZoomRef.current(Math.exp(-d * 0.0012));
      scheduleReanchor();
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const ox = e.clientX - rect.left;
      const oy = e.clientY - rect.top;
      anchor = {
        fx: (el.scrollLeft + ox) / Math.max(1, el.scrollWidth),
        fy: (el.scrollTop + oy) / Math.max(1, el.scrollHeight),
        ox, oy,
      };
      accum += e.deltaY;
      if (!raf) raf = requestAnimationFrame(flush);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => { el.removeEventListener("wheel", onWheel); if (raf) cancelAnimationFrame(raf); if (reRaf) cancelAnimationFrame(reRaf); };
  }, [containerRef, anchorZoom]);

  const active = enabled && panMode;

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (!active) return;
    // Don't hijack clicks on real controls (but DO allow dragging the page — which
    // react-pdf renders as a <canvas>).
    if ((e.target as HTMLElement).closest("button, a, input, textarea, select, [data-no-pan]")) return;
    const el = containerRef.current;
    if (!el) return;
    dragRef.current = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop };
    setDragging(true);
  }, [active, containerRef]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    const el = containerRef.current;
    if (!d || !el) return;
    el.scrollLeft = d.sl - (e.clientX - d.x);
    el.scrollTop = d.st - (e.clientY - d.y);
  }, [containerRef]);

  const endDrag = useCallback(() => { dragRef.current = null; setDragging(false); }, []);

  const cursorClass = active ? (dragging ? "cursor-grabbing" : "cursor-grab") : "";

  return {
    panMode, setPanMode, dragging, cursorClass,
    panHandlers: active
      ? { onPointerDown, onPointerMove, onPointerUp: endDrag, onPointerLeave: endDrag }
      : {},
  };
}
