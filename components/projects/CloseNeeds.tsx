"use client";

// What the post-event review needs a person to put in (lib/closeNeeds):
// each item, where it stands, and a button to the one place it goes.

import React, { useState } from "react";
import { ArrowRight, Check, ChevronDown, ChevronUp } from "lucide-react";
import type { Need, NeedGo } from "@/lib/closeNeeds";

export default function CloseNeeds({ needs, onGo }: { needs: Need[]; onGo: (go: NeedGo) => void }) {
  const done = needs.filter((n) => n.done).length;
  const all = done === needs.length;
  const [open, setOpen] = useState(!all);
  return (
    <section className={`rounded-2xl border-2 p-4 ${all ? "border-emerald-300 dark:border-emerald-800 bg-[var(--color-surface)]" : "border-amber-400 dark:border-amber-700 bg-amber-50/60 dark:bg-amber-950/20"}`} data-close-needs>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="w-full flex items-center gap-2 text-left">
        <span className="min-w-0 flex-1">
          <b className="block text-[15px] text-[var(--color-text)]">What the review needs from you</b>
          <span className="text-[12.5px] text-[var(--color-text-muted)]">{all ? "Everything it measures is in." : `${done} of ${needs.length} in. Each line says where it goes.`}</span>
        </span>
        {open ? <ChevronUp className="w-5 h-5 text-[var(--color-text-muted)]" /> : <ChevronDown className="w-5 h-5 text-[var(--color-text-muted)]" />}
      </button>
      {open && (
        <ol className="mt-3 divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
          {needs.map((n) => (
            <li key={n.id} className="flex items-start gap-3 px-3 py-2.5 flex-wrap" data-need={n.id} data-need-done={n.done ? "1" : "0"}>
              <span className={`mt-0.5 w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${n.done ? "bg-emerald-600 text-white" : "bg-amber-500 text-white"}`}>
                {n.done ? <Check className="w-4 h-4" /> : <span className="text-[13px] font-black">!</span>}
              </span>
              <span className="min-w-0 flex-1 basis-56">
                <b className="block text-[13.5px] leading-snug text-[var(--color-text)]">{n.title}</b>
                <span className="block text-[12.5px] text-[var(--color-text-muted)]">{n.status}</span>
                <span className="block text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-faint)]">{n.category}</span>
              </span>
              <button type="button" onClick={() => onGo(n.go)}
                className={`inline-flex items-center gap-1 h-9 px-3 rounded-lg text-[12.5px] font-bold whitespace-nowrap ${n.done ? "border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]" : "bg-[var(--color-accent)] text-[var(--color-accent-fg)]"}`}>
                {n.button} <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
