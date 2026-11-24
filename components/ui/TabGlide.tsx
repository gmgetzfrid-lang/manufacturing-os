"use client";

// TabGlide: the current tab's underline slides to the tab you pick instead
// of jumping. Drop it inside a tab strip that has `relative tab-glide`; it
// finds the strip's current tab ([aria-current=page] or
// [aria-selected=true]), measures it and moves one bar under it. It
// remembers where the bar was per strip (by `id`), so it also glides when
// picking a tab loads a new page. While it runs, the tabs' own underline
// is hidden (globals.css .tab-glide[data-glide]); without it, they show as
// before. Reduced motion: the bar moves without sliding.

import React, { useLayoutEffect, useRef } from "react";

const last = new Map<string, { x: number; w: number }>();

export function TabGlide({ id }: { id: string }) {
  const bar = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const el = bar.current;
    const strip = el?.parentElement;
    if (!el || !strip) return;
    let first = true;
    const place = () => {
      const on = [...strip.children].find((c) =>
        c !== el && (c.getAttribute("aria-current") === "page" || c.getAttribute("aria-selected") === "true")) as HTMLElement | undefined;
      if (!on) { el.style.opacity = "0"; strip.removeAttribute("data-glide"); return; }
      const x = on.offsetLeft, w = on.offsetWidth;
      const prev = last.get(id);
      if (first && prev && (prev.x !== x || prev.w !== w)) {
        // Start where this strip's bar was last, then slide.
        el.style.transition = "none";
        el.style.transform = `translateX(${prev.x}px)`;
        el.style.width = `${prev.w}px`;
        void el.offsetWidth;
        el.style.transition = "";
      } else if (first) {
        el.style.transition = "none";
      }
      el.style.transform = `translateX(${x}px)`;
      el.style.width = `${w}px`;
      el.style.opacity = "1";
      strip.setAttribute("data-glide", "");
      if (first) { void el.offsetWidth; requestAnimationFrame(() => { if (bar.current) bar.current.style.transition = ""; }); }
      first = false;
      last.set(id, { x, w });
    };
    place();
    const mo = new MutationObserver(place);
    mo.observe(strip, { subtree: true, attributes: true, attributeFilter: ["aria-current", "aria-selected", "class"], childList: true });
    const ro = new ResizeObserver(place);
    ro.observe(strip);
    return () => { mo.disconnect(); ro.disconnect(); strip.removeAttribute("data-glide"); };
  }, [id]);

  return <span ref={bar} aria-hidden className="tab-glide-bar" />;
}

export default TabGlide;
