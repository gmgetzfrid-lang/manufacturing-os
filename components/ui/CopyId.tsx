"use client";

// CopyId: an ID people copy (a request number like KE-DDRT-26-0003, a tag
// like E-22, a drawing, revision or transmittal number). One click copies
// it; a quiet "Copied" shows beside it for a moment. Set in the condensed
// cut with tabular figures so numbers line up. Says "Couldn't copy" when
// the browser refused, never a false "Copied" (lib/clipboard).
//
//   <CopyId value={ticket.number} />
//   <CopyId value={doc.number} label="drawing number">{doc.number}</CopyId>

import React from "react";
import { Check, Copy } from "lucide-react";
import { copyText } from "@/lib/clipboard";

const SHOW_MS = 1400;

export function CopyId({
  value,
  children,
  label = "ID",
  className = "",
}: {
  /** The text that goes on the clipboard. */
  value: string;
  /** What shows (defaults to the value). */
  children?: React.ReactNode;
  /** What it is, for the tooltip and screen readers ("request number"). */
  label?: string;
  className?: string;
}) {
  const [state, setState] = React.useState<"idle" | "copied" | "failed">("idle");
  React.useEffect(() => {
    if (state === "idle") return;
    const t = window.setTimeout(() => setState("idle"), SHOW_MS);
    return () => window.clearTimeout(t);
  }, [state]);
  const copy = async (e: React.MouseEvent) => {
    // Inside a clickable row, copying doesn't also open the row.
    e.preventDefault();
    e.stopPropagation();
    setState((await copyText(value)) ? "copied" : "failed");
  };
  return (
    <span className={`group/copy inline-flex items-center gap-1.5 min-w-0 ${className}`}>
      <button
        type="button"
        onClick={copy}
        title={`Copy ${label} ${value}`}
        aria-label={`${value}. Copy ${label}`}
        className="inline-flex items-center gap-1 min-w-0 rounded-md -mx-1 px-1 font-display font-semibold tabular-nums text-[var(--color-heading)] hover:bg-[var(--color-surface-2)] transition-colors"
      >
        <span className="truncate">{children ?? value}</span>
        <Copy aria-hidden className="w-3.5 h-3.5 shrink-0 text-[var(--color-text-faint)] opacity-0 group-hover/copy:opacity-100 group-focus-within/copy:opacity-100 pointer-coarse:opacity-100 transition-opacity" />
      </button>
      <span aria-live="polite" className="text-caption text-[var(--color-text-muted)] whitespace-nowrap">
        {state === "copied" && <span className="inline-flex items-center gap-1"><Check aria-hidden className="w-3.5 h-3.5 text-[var(--state-released)]" />Copied</span>}
        {state === "failed" && "Couldn't copy"}
      </span>
    </span>
  );
}

export default CopyId;
