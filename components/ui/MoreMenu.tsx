"use client";

// MoreMenu - "More": a screen's less-used actions in one menu, so the few
// used every day stay in sight. Closes on a tap outside or Escape.

import React, { useEffect, useState } from "react";
import { MoreHorizontal } from "lucide-react";

export type MoreItem = { icon: React.ReactNode; label: string; onClick: () => void | Promise<void>; tone?: "good" | "bad"; line?: boolean; current?: boolean };

/** ⋯ More: the project's less-used actions in one menu. `label` and
 *  `triggerClass` dress the button (a tab bar's "More"); `iconOnly` keeps
 *  just the dots, with the label for screen readers. */
export default function MoreMenu({ items, label = "More", triggerClass, iconOnly }: { items: MoreItem[]; label?: string; triggerClass?: string; iconOnly?: boolean }) {
  const [open, setOpen] = useState(false);
  // Opens toward the side with room (the button sits on the left on a phone).
  const [toLeft, setToLeft] = useState(true);
  const box = React.useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent | TouchEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("touchstart", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("touchstart", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button type="button" aria-haspopup="menu" aria-expanded={open} aria-label={iconOnly ? label : undefined} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setToLeft(r.right >= 232); setOpen((o) => !o); }}
        className={triggerClass ?? "inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-lg border text-[13px] font-semibold transition-colors border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}>
        <MoreHorizontal className="w-4 h-4" />{!iconOnly && <span>{label}</span>}
      </button>
      {open && (
        <div role="menu" className={`absolute ${toLeft ? "right-0" : "left-0"} top-full mt-1 z-50 w-56 max-w-[calc(100vw-2rem)] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl py-1`}>
          {items.map((it, i) => (
            <React.Fragment key={it.label}>
              {it.line && i > 0 && <div className="my-1 h-px bg-[var(--color-border)]" />}
              <button type="button" role="menuitem" aria-current={it.current ? "page" : undefined} onClick={() => { setOpen(false); void it.onClick(); }}
                className={`w-full flex items-center gap-2.5 px-3 min-h-11 text-left text-[14px] font-semibold hover:bg-[var(--color-surface-2)] ${it.current ? "bg-[var(--color-surface-2)]" : ""} ${it.tone === "bad" ? "text-rose-700 dark:text-rose-400" : it.tone === "good" ? "text-emerald-700 dark:text-emerald-400" : "text-[var(--color-text)]"}`}>
                {it.icon}{it.label}
              </button>
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
