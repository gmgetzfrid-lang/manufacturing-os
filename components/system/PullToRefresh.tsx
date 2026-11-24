"use client";

// Pull down to refresh, on touch screens (design rule T9). The app scrolls
// inside its own frame, and once installed on a phone there is no browser
// bar, so the phone's own pull-to-refresh never happens. This gives it
// back: at the top of the page, pull down and let go to load the page
// again.
//
// It stays out of the way: it only starts when the page is at the very
// top, never from inside a dialog, a drawing, a map or anything that
// scrolls or drags on its own, never while a field is being typed in, and
// it needs a deliberate pull (about 130 px of finger travel).

import React, { useEffect, useState } from "react";
import { ArrowDown, Loader2 } from "lucide-react";

const PULL_TO_GO = 64;   // damped pull, in px, that refreshes on release
const MAX_PULL = 96;

/** True when the touch starts somewhere that has its own scroll or drag. */
function ownsGesture(target: EventTarget | null, scroller: HTMLElement): boolean {
  for (let el = target as HTMLElement | null; el && el !== scroller; el = el.parentElement) {
    if (el.matches?.('[role="dialog"], [aria-modal="true"], canvas, svg, iframe, [data-no-pull], .leaflet-container, .maplibregl-map')) return true;
    if (el.scrollTop > 0) return true;
    const cs = getComputedStyle(el);
    if (cs.touchAction === "none" || cs.touchAction.startsWith("pan-x")) return true;
  }
  return false;
}

function typing(): boolean {
  const a = document.activeElement as HTMLElement | null;
  return !!a && (a.matches("input, textarea, select") || a.isContentEditable);
}

export function PullToRefresh({ scroller }: { scroller: HTMLElement | null }) {
  const [pull, setPull] = useState(0);
  const [going, setGoing] = useState(false);

  useEffect(() => {
    if (!scroller || !window.matchMedia?.("(pointer: coarse)").matches) return;
    let startX = 0, startY = 0, active = false, dist = 0;
    const set = (d: number) => { dist = d; setPull(d); };
    const onStart = (e: TouchEvent) => {
      active = e.touches.length === 1 && scroller.scrollTop <= 0 && !typing() && !ownsGesture(e.target, scroller);
      if (!active) return;
      startX = e.touches[0].clientX; startY = e.touches[0].clientY; dist = 0;
    };
    const onMove = (e: TouchEvent) => {
      if (!active) return;
      const dy = e.touches[0].clientY - startY;
      const dx = Math.abs(e.touches[0].clientX - startX);
      if (dy <= 0 || dx > dy || scroller.scrollTop > 0) {
        if (dist) set(0);
        if (dy < -4 || dx > 12) active = false;
        return;
      }
      set(Math.min(MAX_PULL, dy * 0.5));
    };
    const onEnd = () => {
      if (!active) return;
      active = false;
      if (dist >= PULL_TO_GO) { setGoing(true); window.location.reload(); return; }
      set(0);
    };
    scroller.addEventListener("touchstart", onStart, { passive: true });
    scroller.addEventListener("touchmove", onMove, { passive: true });
    scroller.addEventListener("touchend", onEnd);
    scroller.addEventListener("touchcancel", onEnd);
    return () => {
      scroller.removeEventListener("touchstart", onStart);
      scroller.removeEventListener("touchmove", onMove);
      scroller.removeEventListener("touchend", onEnd);
      scroller.removeEventListener("touchcancel", onEnd);
    };
  }, [scroller]);

  if (!pull && !going) return null;
  const ready = going || pull >= PULL_TO_GO;
  return (
    <div className="pointer-events-none sticky top-0 z-[60] h-0 flex justify-center">
      <div
        role="status"
        className="ui-float mt-2 inline-flex items-center gap-2 h-9 px-3.5 rounded-full border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-body font-medium text-[var(--color-text)]"
        style={{ transform: `translateY(${going ? PULL_TO_GO / 2 : pull / 2}px)`, opacity: Math.min(1, pull / 32 || 1) }}
      >
        {going
          ? <><Loader2 aria-hidden className="w-4 h-4 animate-spin" /> Refreshing</>
          : <><ArrowDown aria-hidden className="w-4 h-4 transition-transform" style={{ transform: ready ? "rotate(180deg)" : "none" }} /> {ready ? "Let go to refresh" : "Pull to refresh"}</>}
      </div>
    </div>
  );
}

export default PullToRefresh;
