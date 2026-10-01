"use client";

// HelpTooltip — small (?) icon that reveals a popover with a plain-
// language explanation of a technical term or operational concept.
// Click to toggle, click-outside to close, ESC to close.
//
// Designed to be sprinkled next to confusing labels (MOC, SPI, scope
// FKs, etc.) without dominating the layout. Per the directive's
// Phase 10 rules: lightweight inline, not modal-heavy.
//
// A disclosure, not a hover tip (projects A11Y-12): the trigger is a real
// button in the tab order with a visible focus ring, it says whether the
// note is open (aria-expanded) and which element it opens (aria-controls),
// and callers may name what it explains (`label`). Escape closes an open
// note first — it is handled in the capture phase and marked
// (defaultPrevented), so a dialog the note sits in stays open. It marks the
// key only when the note is the thing in front: focus is inside it, or it
// sits in the topmost open dialog (or no dialog is open). A note left open
// on the page BEHIND a dialog closes quietly and lets the dialog have the
// same Escape. The note also closes when focus moves somewhere else (Tab
// away, or a dialog taking focus), so it is not left open behind one.

import React, { useEffect, useId, useRef, useState } from "react";
import { HelpCircle } from "lucide-react";

interface HelpTooltipProps {
  /** Plain-language explanation. Can include JSX for emphasis. */
  children: React.ReactNode;
  /** Optional. Defaults to opening downward. */
  placement?: "top" | "bottom" | "left" | "right";
  /** Size of the trigger icon. Defaults to a small inline icon. */
  size?: "sm" | "md";
  /** Optional className on the trigger button. */
  className?: string;
  /** Accessible name of the trigger — what the note explains. Defaults to
   *  "More info". */
  label?: string;
}

export default function HelpTooltip({
  children, placement = "bottom", size = "sm", className = "", label = "More info",
}: HelpTooltipProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const popId = useId();

  useEffect(() => {
    if (!open) return;
    const onClickAway = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const root = rootRef.current;
      const focusInside = !!root && root.contains(document.activeElement);
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      const top = dialogs.length > 0 ? dialogs[dialogs.length - 1] : null;
      const inFront = focusInside || !top || (!!root && top.contains(root));
      if (inFront) e.preventDefault();
      setOpen(false);
    };
    window.addEventListener("mousedown", onClickAway);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onClickAway);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const iconSize = size === "md" ? "w-4 h-4" : "w-3.5 h-3.5";
  const popClass =
    placement === "top"    ? "bottom-full mb-1 left-0" :
    placement === "left"   ? "right-full mr-1 top-0" :
    placement === "right"  ? "left-full ml-1 top-0" :
                             "top-full mt-1 left-0";

  return (
    <span ref={rootRef} className={`relative inline-flex items-center ${className}`}
      onBlur={(e) => {
        // Focus moved to another element outside the note (Tab, a dialog
        // opening). A click on the note's own text moves focus nowhere
        // (relatedTarget null) and keeps it open; a click elsewhere is
        // handled by the mousedown listener.
        const next = e.relatedTarget as Node | null;
        if (open && next && !rootRef.current?.contains(next)) setOpen(false);
      }}>
      <button
        type="button"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((v) => !v); }}
        className="rounded text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)] transition-colors"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
      >
        <HelpCircle className={iconSize} />
      </button>
      {open && (
        <div
          id={popId}
          className={`absolute z-[300] ${popClass} w-64 bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border)] ring-1 ring-black/5 text-[11px] leading-relaxed rounded-lg shadow-md p-3 animate-in fade-in zoom-in-95 duration-150`}
          role="note"
        >
          {children}
        </div>
      )}
    </span>
  );
}
