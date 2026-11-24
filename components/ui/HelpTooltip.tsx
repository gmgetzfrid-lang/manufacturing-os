"use client";

// HelpTooltip — small (?) icon that reveals a popover with a plain-
// language explanation of a technical term or operational concept.
// Click to toggle, click-outside to close, ESC to close.
//
// Designed to be sprinkled next to confusing labels (MOC, SPI, scope
// FKs, etc.) without dominating the layout. Per the directive's
// Phase 10 rules: lightweight inline, not modal-heavy.

import React, { useEffect, useRef, useState } from "react";
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
}

export default function HelpTooltip({
  children, placement = "bottom", size = "sm", className = "",
}: HelpTooltipProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClickAway = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onClickAway);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClickAway);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const iconSize = size === "md" ? "w-4 h-4" : "w-3.5 h-3.5";
  const popClass =
    placement === "top"    ? "bottom-full mb-1 left-0" :
    placement === "left"   ? "right-full mr-1 top-0" :
    placement === "right"  ? "left-full ml-1 top-0" :
                             "top-full mt-1 left-0";

  return (
    <span ref={rootRef} className={`relative inline-flex items-center ${className}`}>
      <button
        type="button"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((v) => !v); }}
        className="ui-hit rounded-full text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)] transition-colors"
        aria-label="More info"
      >
        <HelpCircle className={iconSize} />
      </button>
      {open && (
        <div
          className={`on-sheet absolute z-[300] ${popClass} w-72 max-w-[calc(100vw-2rem)] max-sm:fixed max-sm:inset-x-4 max-sm:bottom-4 max-sm:top-auto max-sm:left-4 max-sm:right-4 max-sm:w-auto max-sm:max-w-none max-sm:m-0 max-sm:translate-x-0 max-sm:translate-y-0 max-sm:z-[400] bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border-strong)] text-body leading-snug rounded-lg ui-float p-3 animate-in fade-in zoom-in-95 duration-150`}
          role="tooltip"
        >
          {children}
        </div>
      )}
    </span>
  );
}
