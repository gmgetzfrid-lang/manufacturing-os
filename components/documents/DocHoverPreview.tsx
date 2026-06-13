"use client";

// DocHoverPreview — wrap any document reference; on hover (desktop), a larger
// floating first-page preview pops next to it. Makes document links across the
// app tactile without a click. No-ops gracefully on touch (no hover) and when
// the preview can't render.

import React from "react";
import { createPortal } from "react-dom";
import DocThumb from "@/components/documents/DocThumb";

export default function DocHoverPreview({
  documentId,
  filePath,
  label,
  children,
  previewWidth = 240,
  delayMs = 250,
}: {
  documentId?: string | null;
  filePath?: string | null;
  label?: React.ReactNode;
  children: React.ReactNode;
  previewWidth?: number;
  delayMs?: number;
}) {
  const wrapRef = React.useRef<HTMLSpanElement>(null);
  const timer = React.useRef<number | null>(null);
  const [pos, setPos] = React.useState<{ left: number; top: number } | null>(null);

  const show = () => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const previewH = previewWidth * 1.3 + 48;
    // Prefer right of the element; flip left if it would overflow.
    let left = r.right + 10;
    if (left + previewWidth + 16 > window.innerWidth) left = Math.max(8, r.left - previewWidth - 10);
    // Vertically center on the element, clamped to viewport.
    let top = r.top + r.height / 2 - previewH / 2;
    top = Math.max(8, Math.min(top, window.innerHeight - previewH - 8));
    setPos({ left, top });
  };

  const onEnter = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(show, delayMs);
  };
  const onLeave = () => {
    if (timer.current) window.clearTimeout(timer.current);
    setPos(null);
  };

  React.useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  if (!documentId && !filePath) return <>{children}</>;

  return (
    <span ref={wrapRef} onPointerEnter={(e) => { if (e.pointerType !== "touch") onEnter(); }} onPointerLeave={onLeave} className="inline-flex">
      {children}
      {pos && typeof document !== "undefined" && createPortal(
        <div
          className="fixed z-[800] pointer-events-none rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] ring-1 ring-black/5 shadow-lg p-2 animate-in fade-in zoom-in-95 duration-150"
          style={{ left: pos.left, top: pos.top }}
        >
          <DocThumb documentId={documentId} filePath={filePath} width={previewWidth} />
          {label && <div className="mt-1.5 max-w-[240px] text-[11px] font-bold text-[var(--color-text-muted)] truncate px-0.5">{label}</div>}
        </div>,
        document.body,
      )}
    </span>
  );
}
