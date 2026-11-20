"use client";

// CollapsibleSection — a titled, chevroned group that remembers whether the
// user left it open (localStorage, per section id). Built for the document
// Inspector: heavy feature panels collapse to a one-line header with an
// optional at-a-glance summary (status pills), so everything stays reachable
// without burying the essentials.

import React, { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export default function CollapsibleSection({
  id, title, icon: Icon, summary, defaultOpen = false, children,
}: {
  /** Persistence key — stable per section (e.g. "compliance"). */
  id: string;
  title: string;
  icon?: LucideIcon;
  /** Right-aligned at-a-glance content shown on the header (pills, counts). */
  summary?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const storageKey = `mfg.inspector.sec.${id}`;
  const [open, setOpen] = useState(defaultOpen);

  // Restore the user's last choice. Async read so render stays pure.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const v = localStorage.getItem(storageKey);
        if (alive && v !== null) setOpen(v === "1");
      } catch { /* private mode — keep the default */ }
    })();
    return () => { alive = false; };
  }, [storageKey]);

  const toggle = () => {
    setOpen((o) => {
      const next = !o;
      try { localStorage.setItem(storageKey, next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  };

  return (
    // A plain section on its card, split by a hairline: no box in a box.
    <div className="border-t border-[var(--color-border)] first:border-t-0">
      <button
        type="button"
        onClick={toggle}
        className="w-full min-h-11 flex items-center gap-2 px-1 py-2.5 text-left hover:bg-[var(--color-surface-2)] rounded-lg transition-colors"
        aria-expanded={open}
      >
        <ChevronRight className={`w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        {Icon && <Icon className="w-3.5 h-3.5 text-[var(--color-text-muted)] shrink-0" />}
        <span className="text-xs font-black uppercase tracking-wider text-[var(--color-text-muted)]">{title}</span>
        {summary && <span className="ml-auto flex items-center gap-1 flex-wrap justify-end min-w-0">{summary}</span>}
      </button>
      {open && (
        <div className="px-1 pb-4 pt-1 space-y-3">
          {children}
        </div>
      )}
    </div>
  );
}
