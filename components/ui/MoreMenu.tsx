"use client";

// MoreMenu - "More": a screen's less-used actions in one menu, so the few
// used every day stay in sight. Closes on a tap outside or Escape. The menu
// is drawn on top of the page (not inside its button's box), so a header
// band that clips its own edges never cuts it off.

import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";
import { useEscapeClose } from "@/hooks/useEscapeClose";

export type MoreItem = { icon: React.ReactNode; label: string; onClick: () => void | Promise<void>; tone?: "good" | "bad"; line?: boolean; current?: boolean };

/** ⋯ More: the project's less-used actions in one menu. `label` and
 *  `triggerClass` dress the button (a tab bar's "More"); `iconOnly` keeps
 *  just the dots, with the label for screen readers. */
export default function MoreMenu({ items, label = "More", triggerClass, iconOnly, trigger, boxClass }: {
  items: MoreItem[]; label?: string; triggerClass?: string; iconOnly?: boolean;
  /** The button's own face (a workspace's logo, "+ New") instead of ⋯ and
   *  the label; `label` then names it for screen readers. */
  trigger?: React.ReactNode;
  /** Classes for the wrapper (e.g. "flex-1 min-w-0" for a full-width face). */
  boxClass?: string;
}) {
  const [open, setOpen] = useState(false);
  // Where the menu goes: under the button, toward the side with room (the
  // button sits on the left on a phone).
  const [at, setAt] = useState<{ top: number; left?: number; right?: number }>({ top: 0 });
  const box = React.useRef<HTMLDivElement | null>(null);
  const menu = React.useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const inside = (t: EventTarget | null) => !!t && ((box.current?.contains(t as Node) ?? false) || (menu.current?.contains(t as Node) ?? false));
    const away = (e: MouseEvent | TouchEvent) => { if (!inside(e.target)) setOpen(false); };
    // The page moving under it: the menu would float away from its button.
    const moved = (e: Event) => { if (!inside(e.target)) setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("touchstart", away);
    window.addEventListener("scroll", moved, true);
    window.addEventListener("resize", moved);
    return () => {
      document.removeEventListener("mousedown", away); document.removeEventListener("touchstart", away);
      window.removeEventListener("scroll", moved, true); window.removeEventListener("resize", moved);
    };
  }, [open]);
  const place = (r: DOMRect) => setAt(r.right >= 232 ? { top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) } : { top: r.bottom + 4, left: Math.max(8, r.left) });
  // Escape closes the open menu first, not the screen or dialog under it.
  useEscapeClose(() => setOpen(false), open);
  return (
    <div ref={box} className={`relative ${boxClass ?? ""}`}>
      <button type="button" aria-haspopup="menu" aria-expanded={open} aria-label={iconOnly || trigger ? label : undefined} onClick={(e) => { place(e.currentTarget.getBoundingClientRect()); setOpen((o) => !o); }}
        title={iconOnly ? label : undefined}
        className={triggerClass ?? "inline-flex items-center justify-center gap-1.5 h-10 pointer-coarse:h-11 px-3 rounded-lg border text-body font-medium transition-colors border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)] hover:border-[var(--color-border-control)]"}>
        {trigger ?? <><MoreHorizontal className="w-4 h-4" />{!iconOnly && <span>{label}</span>}</>}
      </button>
      {open && typeof document !== "undefined" && createPortal(
        // It floats (the one shadow for things above the page) and grows
        // out of the corner next to its button.
        <div ref={menu} role="menu" style={{ top: at.top, left: at.left, right: at.right, transformOrigin: at.right !== undefined ? "top right" : "top left" }}
          className="on-sheet ui-float ui-float-in fixed z-[650] w-56 max-w-[calc(100vw-2rem)] max-h-[calc(100dvh-5rem)] overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] py-1">
          {items.map((it, i) => (
            <React.Fragment key={it.label}>
              {it.line && i > 0 && <div className="my-1 h-px bg-[var(--color-border)]" />}
              <button type="button" role="menuitem" aria-current={it.current ? "page" : undefined} onClick={() => { setOpen(false); void it.onClick(); }}
                className={`w-full flex items-center gap-2.5 px-3 min-h-11 text-left text-body font-medium hover:bg-[var(--color-surface-2)] ${it.current ? "bg-[var(--color-surface-2)]" : ""} ${it.tone === "bad" ? "text-[var(--state-overdue-text)]" : it.tone === "good" ? "text-[var(--state-released-text)]" : "text-[var(--color-text)]"}`}>
                {it.icon}{it.label}
              </button>
            </React.Fragment>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
