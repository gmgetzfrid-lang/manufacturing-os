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
}) {
  const { containerRef, onZoom, enabled = true } = opts;
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
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let accum = 0;
    let raf = 0;
    const flush = () => {
      raf = 0;
      const d = accum;
      accum = 0;
      if (d === 0) return;
      // ~12% per typical wheel notch (deltaY≈100); accumulated deltas compound.
      onZoomRef.current(Math.exp(-d * 0.0012));
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      accum += e.deltaY;
      if (!raf) raf = requestAnimationFrame(flush);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => { el.removeEventListener("wheel", onWheel); if (raf) cancelAnimationFrame(raf); };
  }, [containerRef]);

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
