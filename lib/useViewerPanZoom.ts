// useViewerPanZoom — shared "operate like a normal PDF viewer" gestures for the
// scroll-stack viewers (full-screen markup viewer, collection book,
// file-reference modal, revision diff):
//   - Grab-hand drag       → pan the page (drag-to-scroll the container);
//                            works with a mouse AND a single finger.
//   - Ctrl + mouse-wheel   → zoom, anchored to the cursor (we preventDefault
//                            the browser's own page-zoom).
//   - Two-finger pinch     → zoom, anchored to the pinch midpoint. The host
//                            container should set touch-action so the browser
//                            doesn't consume the gesture first ("none" while a
//                            pan/draw tool owns touches, or "pan-x pan-y" to
//                            keep native scroll but claim the pinch).
//
// The host owns the actual zoom model (react-pdf re-renders at a new width);
// this hook turns gestures into multiplicative zoom callbacks and drag into
// scroll. Anchoring uses scale-invariant scroll fractions, re-applied for a few
// frames after the async re-raster so the anchored point genuinely stays put.

import { useCallback, useEffect, useRef, useState } from "react";

export function useViewerPanZoom(opts: {
  containerRef: React.RefObject<HTMLElement | null>;
  /** Called with a multiplicative zoom factor (>1 zoom in, <1 zoom out) already
   *  smoothed + throttled to one update per animation frame. The host clamps and
   *  applies it (e.g. setZoom(z => clamp(z * factor))). */
  onZoom: (factor: number) => void;
  /** Pan is only active when this is true (e.g. disable while marking up).
   *  Pinch-zoom stays active regardless — two fingers always mean zoom. */
  enabled?: boolean;
  /** Keep the point under the cursor/pinch pinned while zooming by adjusting
   *  the container's scroll. True for the scroll-stack viewers; set false for
   *  hosts that center/translate their own content. */
  anchorZoom?: boolean;
}) {
  const { containerRef, onZoom, enabled = true, anchorZoom = true } = opts;
  const [panMode, setPanMode] = useState(true);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);
  const onZoomRef = useRef(onZoom);
  useEffect(() => { onZoomRef.current = onZoom; });

  // ── Cursor/midpoint-anchored zoom, shared by wheel and pinch ──────────
  // fx/fy are fractions of the scroll content (scale-invariant); ox/oy the
  // viewport offset of the anchor point. Re-applied over a few frames because
  // the PDF re-rasters asynchronously after the zoom state lands.
  const anchorRef = useRef<{ fx: number; fy: number; ox: number; oy: number } | null>(null);
  const reRafRef = useRef(0);
  const scheduleReanchor = useCallback(() => {
    const el = containerRef.current;
    if (!anchorZoom || !anchorRef.current || !el) return;
    let n = 0;
    if (reRafRef.current) cancelAnimationFrame(reRafRef.current);
    const step = () => {
      const a = anchorRef.current;
      if (a && el) {
        el.scrollLeft = a.fx * el.scrollWidth - a.ox;
        el.scrollTop = a.fy * el.scrollHeight - a.oy;
      }
      reRafRef.current = ++n < 6 ? requestAnimationFrame(step) : 0;
    };
    reRafRef.current = requestAnimationFrame(step);
  }, [anchorZoom, containerRef]);
  const setAnchor = useCallback((clientX: number, clientY: number) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const ox = clientX - rect.left;
    const oy = clientY - rect.top;
    anchorRef.current = {
      fx: (el.scrollLeft + ox) / Math.max(1, el.scrollWidth),
      fy: (el.scrollTop + oy) / Math.max(1, el.scrollHeight),
      ox, oy,
    };
  }, [containerRef]);
  useEffect(() => () => { if (reRafRef.current) cancelAnimationFrame(reRafRef.current); }, []);

  // ── Ctrl+wheel zoom ───────────────────────────────────────────────────
  // Native non-passive listener so preventDefault suppresses the browser's own
  // page zoom. Wheel deltas are ACCUMULATED and flushed once per animation
  // frame as a single PROPORTIONAL factor — a fast scroll or high-resolution
  // trackpad produces one smooth zoom step per frame instead of a burst of
  // fixed jumps that each re-rasterize the PDF.
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
      scheduleReanchor();
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setAnchor(e.clientX, e.clientY);
      accum += e.deltaY;
      if (!raf) raf = requestAnimationFrame(flush);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => { el.removeEventListener("wheel", onWheel); if (raf) cancelAnimationFrame(raf); };
  }, [containerRef, setAnchor, scheduleReanchor]);

  const active = enabled && panMode;

  // ── Pointers: one finger/mouse pans, two fingers pinch-zoom ──────────
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ dist: number } | null>(null);

  const beginPinchIfReady = useCallback(() => {
    const pts = [...pointersRef.current.values()];
    if (pts.length !== 2) return;
    dragRef.current = null;             // pinch wins over pan
    setDragging(false);
    pinchRef.current = { dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) };
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === "touch") {
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointersRef.current.size === 2) { beginPinchIfReady(); return; }
    }
    if (!active) return;
    // Don't hijack clicks on real controls (but DO allow dragging the page — which
    // react-pdf renders as a <canvas>).
    if ((e.target as HTMLElement).closest("button, a, input, textarea, select, [data-no-pan]")) return;
    const el = containerRef.current;
    if (!el) return;
    dragRef.current = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop };
    setDragging(true);
  }, [active, containerRef, beginPinchIfReady]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === "touch" && pointersRef.current.has(e.pointerId)) {
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const pinch = pinchRef.current;
      if (pinch && pointersRef.current.size >= 2) {
        const pts = [...pointersRef.current.values()];
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (dist > 0 && pinch.dist > 0) {
          const factor = dist / pinch.dist;
          // Flush in small proportional steps so the raster keeps up.
          if (Math.abs(factor - 1) > 0.02) {
            setAnchor((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2);
            onZoomRef.current(factor);
            scheduleReanchor();
            pinch.dist = dist;
          }
        }
        return;
      }
    }
    const d = dragRef.current;
    const el = containerRef.current;
    if (!d || !el) return;
    el.scrollLeft = d.sl - (e.clientX - d.x);
    el.scrollTop = d.st - (e.clientY - d.y);
  }, [containerRef, setAnchor, scheduleReanchor]);

  const endDrag = useCallback((e?: React.PointerEvent) => {
    if (e && e.pointerType === "touch") {
      pointersRef.current.delete(e.pointerId);
      if (pointersRef.current.size < 2) pinchRef.current = null;
      if (pointersRef.current.size > 0) return; // other finger still down
    } else {
      pointersRef.current.clear();
      pinchRef.current = null;
    }
    dragRef.current = null;
    setDragging(false);
  }, []);

  const cursorClass = active ? (dragging ? "cursor-grabbing" : "cursor-grab") : "";

  // Pinch must work in every tool, so the pointer handlers are always
  // attached; pan-drag inside them still respects `active`.
  return {
    panMode, setPanMode, dragging, cursorClass,
    panHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onPointerLeave: endDrag,
    },
  };
}
