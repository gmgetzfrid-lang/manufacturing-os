"use client";

// One slide drawn from the file (lib/slideRender), scaled to the room it's
// given: to the width, or to fit both ways with `fit`. The slide's HTML is
// built from the file with every text escaped (see slideRender).

import React, { useLayoutEffect, useRef, useState } from "react";

export default function SlideFrame({ html, w, h, fit, onRow, className = "", label }: {
  html: string; w: number; h: number;
  /** Fit inside the parent both ways (a stage), instead of filling its width. */
  fit?: boolean;
  /** A table row was tapped: its number under the head row. */
  onRow?: (row: number) => void;
  className?: string;
  label?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scale = size ? (fit ? Math.min(size.w / w, size.h / h) : size.w / w) : 0;
  const click = onRow ? (e: React.MouseEvent) => {
    const tr = (e.target as HTMLElement).closest("tr[data-row]");
    if (tr) onRow(Number(tr.getAttribute("data-row")));
  } : undefined;
  return (
    <div ref={box} className={`relative ${fit ? "w-full h-full" : "w-full"} ${className}`} style={fit ? undefined : { aspectRatio: `${w} / ${h}` }} aria-label={label} role={label ? "img" : undefined}>
      {scale > 0 && (
        <div onClick={click} style={{ position: "absolute", width: w, height: h, left: fit ? (size!.w - w * scale) / 2 : 0, top: fit ? (size!.h - h * scale) / 2 : 0, transform: `scale(${scale})`, transformOrigin: "top left", boxShadow: "0 1px 3px rgb(0 0 0 / 0.25)", cursor: onRow ? "default" : undefined }}
          dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
}
