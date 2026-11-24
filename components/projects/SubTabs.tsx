"use client";

// The views inside a project tab (Report / Meeting, Timeline / Calendar /
// Work orders, the Costs parts): an underline strip, the way the page's
// own tabs read. The one you're on is text color with the accent line
// under it; the rest are muted. A count is plain muted figures after the
// label; a dot marks one that needs someone. Switching cross-fades where
// the browser can (lib/viewTransition), and is instant under reduced
// motion. Arrow keys move along the strip.

import React from "react";
import { flushSync } from "react-dom";
import { withViewTransition } from "@/lib/viewTransition";
import { TabGlide } from "@/components/ui/TabGlide";

export interface SubTab<T extends string> {
  id: T;
  label: React.ReactNode;
  /** Plain muted figures after the label (nothing when 0 or undefined). */
  count?: number;
  /** A small dot: this view has something that needs someone. */
  dot?: "bad" | "warn";
  /** Shown only from this width up (the rest live in a menu on a phone). */
  className?: string;
  title?: string;
}

export function SubTabs<T extends string>({ items, value, onChange, label, className = "", size = "md", right }: {
  items: Array<SubTab<T>>;
  value: T;
  onChange: (id: T) => void;
  /** What the strip switches, for screen readers ("Costs views"). */
  label: string;
  className?: string;
  /** "sm" inside a dense toolbar row. */
  size?: "sm" | "md";
  /** Things on the strip's right (a count, a tool). */
  right?: React.ReactNode;
}) {
  const refs = React.useRef(new Map<T, HTMLButtonElement>());
  const pick = (id: T) => {
    if (id === value) return;
    withViewTransition(() => flushSync(() => onChange(id)));
  };
  const onKey = (e: React.KeyboardEvent, i: number) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const n = items.length;
    const j = e.key === "Home" ? 0 : e.key === "End" ? n - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + n) % n;
    const id = items[j].id;
    refs.current.get(id)?.focus();
    pick(id);
  };
  const h = size === "sm" ? "h-9 pointer-coarse:h-11" : "h-10 pointer-coarse:h-11";
  return (
    <div className={`flex items-end gap-x-4 min-w-0 max-w-full ${className}`}>
      <div role="tablist" aria-label={label}
        className="relative tab-glide -mb-px flex items-end gap-5 min-w-0 max-w-full overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {items.map((t, i) => {
          const on = t.id === value;
          return (
            <button key={t.id} ref={(el) => { if (el) refs.current.set(t.id, el); else refs.current.delete(t.id); }}
              type="button" role="tab" aria-selected={on} tabIndex={on ? 0 : -1} title={t.title}
              onClick={() => pick(t.id)} onKeyDown={(e) => onKey(e, i)}
              className={`shrink-0 whitespace-nowrap inline-flex items-center gap-1.5 ${h} border-b-2 text-body transition-colors ${
                on ? "border-[var(--color-current)] text-[var(--color-text)] font-medium"
                  : "border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-border-strong)]"
              } ${t.className ?? ""}`}>
              {t.label}
              {!!t.count && <span className="text-body font-normal tabular-nums text-[var(--color-text-muted)]">{t.count}</span>}
              {t.dot && <span aria-hidden className="w-1.5 h-1.5 rounded-full" style={{ background: t.dot === "bad" ? "var(--state-overdue)" : "var(--state-held)" }} />}
            </button>
          );
        })}
        <TabGlide id={`sub:${label}`} />
      </div>
      {right && <div className="ml-auto self-center shrink-0">{right}</div>}
    </div>
  );
}

export default SubTabs;
