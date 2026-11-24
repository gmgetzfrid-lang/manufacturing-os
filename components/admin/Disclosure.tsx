// A collapsed block of detail on an admin page: a title and a quiet summary
// on the right; the chevron turns as it opens (and holds still under
// reduced motion). Native <details>, so the keyboard and screen readers
// get the open/closed state for free.

import React from "react";
import { ChevronRight } from "lucide-react";

export default function Disclosure({ title, meta, open, onToggle, children, className = "", bodyClassName = "px-4 sm:px-5 pb-4 pt-1" }: {
  title: React.ReactNode;
  meta?: React.ReactNode;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <details open={open} onToggle={onToggle ? (e) => onToggle((e.currentTarget as HTMLDetailsElement).open) : undefined}
      className={`group/d rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] ${className}`}>
      <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden flex items-center gap-2.5 px-4 sm:px-5 min-h-12 py-2.5 rounded-xl hover:bg-[var(--color-surface-2)] transition-colors">
        <ChevronRight aria-hidden className="ui-chevron w-4 h-4 shrink-0 text-[var(--color-text-muted)] group-open/d:rotate-90" />
        <span className="text-reading font-medium text-[var(--color-text)]">{title}</span>
        {meta && <span className="ml-auto pl-3 text-body text-[var(--color-text-muted)] tabular-nums text-right">{meta}</span>}
      </summary>
      <div className={bodyClassName}>{children}</div>
    </details>
  );
}
