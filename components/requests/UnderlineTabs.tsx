"use client";

// Underline tabs for switching views inside one page (List / By drafter,
// Discussion / History, Collisions / Document flow): the one you're on is
// text color with a brand line under it, the rest muted, a count as plain
// muted figures. Arrow keys move between tabs. The switch cross-fades where
// the browser can (lib/viewTransition), instantly elsewhere.

import React from "react";
import { flushSync } from "react-dom";
import { withViewTransition } from "@/lib/viewTransition";
import { TabGlide } from "@/components/ui/TabGlide";

export interface UnderlineTab<K extends string> { key: K; label: React.ReactNode; count?: number; icon?: React.ComponentType<{ className?: string }> }

export default function UnderlineTabs<K extends string>({
  tabs, value, onChange, label, size = "md", className = "", idBase,
}: {
  tabs: Array<UnderlineTab<K>>;
  value: K;
  onChange: (k: K) => void;
  /** What the tabs switch, for screen readers ("Request views"). */
  label: string;
  /** "lg" for tabs that head a section (20 px). */
  size?: "md" | "lg";
  className?: string;
  /** Ties each tab to its panel (`${idBase}-panel`). */
  idBase?: string;
}) {
  const refs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const pick = (k: K) => {
    if (k === value) return;
    withViewTransition(() => { flushSync(() => onChange(k)); });
  };
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const n = tabs.length;
    const to = e.key === "ArrowRight" ? (i + 1) % n : e.key === "ArrowLeft" ? (i - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    refs.current[to]?.focus();
    pick(tabs[to].key);
  };
  const text = size === "lg" ? "font-display text-section leading-tight" : "text-body";
  return (
    <div role="tablist" aria-label={label}
      className={`relative tab-glide flex items-end gap-5 min-w-0 max-w-full overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${className}`}>
      {tabs.map((t, i) => {
        const on = t.key === value;
        const Icon = t.icon;
        return (
          <button key={t.key} ref={(el) => { refs.current[i] = el; }} type="button" role="tab"
            id={idBase ? `${idBase}-${t.key}` : undefined}
            aria-selected={on} aria-controls={idBase ? `${idBase}-panel` : undefined}
            tabIndex={on ? 0 : -1}
            onClick={() => pick(t.key)} onKeyDown={(e) => onKey(e, i)}
            className={`shrink-0 whitespace-nowrap inline-flex items-center justify-center gap-1.5 pointer-coarse:min-w-11 ${size === "lg" ? "pb-1.5" : "h-10 pointer-coarse:h-11"} border-b-2 transition-colors ${text} ${
              on ? "border-[var(--color-current)] text-[var(--color-text)] font-medium" : "border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-border-strong)]"
            }`}>
            {Icon && <Icon className="w-4 h-4" />}
            {t.label}
            {typeof t.count === "number" && t.count > 0 && (
              <span className="font-sans text-body font-normal tabular-nums text-[var(--color-text-muted)]">{t.count.toLocaleString()}</span>
            )}
          </button>
        );
      })}
      <TabGlide id={`tabs:${label}`} />
    </div>
  );
}
