"use client";

// What the post-event review needs a person to put in (lib/closeNeeds):
// the next thing to put in, with a button to the one place it goes, and
// the whole list a tap away.

import React, { useState } from "react";
import { ArrowRight, Check, ChevronDown, ChevronUp } from "lucide-react";
import type { Need, NeedGo } from "@/lib/closeNeeds";

export default function CloseNeeds({ needs, onGo }: { needs: Need[]; onGo: (go: NeedGo) => void }) {
  const done = needs.filter((n) => n.done).length;
  const all = done === needs.length;
  const next = needs.find((n) => !n.done) ?? null;
  const [open, setOpen] = useState(false);
  // Each a secondary button: the page's one filled button is in the header.
  const go = (n: Need) => (
    <button type="button" onClick={() => onGo(n.go)}
      className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[14px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] whitespace-nowrap transition-colors">
      {n.button} <ArrowRight className="w-3.5 h-3.5" />
    </button>
  );
  return (
    <section className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] p-4 sm:p-5" data-close-needs>
      <div className="flex items-center gap-3 flex-wrap">
        <div className="min-w-0 flex-1 basis-56">
          <b className="block text-[13px] font-semibold text-[var(--color-text-muted)]">What the review needs from you</b>
          <div className="mt-1.5 flex items-center gap-2">
            <div className="h-1.5 flex-1 max-w-[220px] rounded-full bg-[var(--color-accent-soft)] overflow-hidden" aria-hidden>
              <div className="h-full rounded-full bg-[var(--color-main)]" style={{ width: `${Math.round((done / Math.max(1, needs.length)) * 100)}%` }} />
            </div>
            <span className="text-[13px] text-[var(--color-text-muted)] tabular-nums">{all ? "Everything it measures is in" : `${done} of ${needs.length} in`}</span>
          </div>
        </div>
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[14px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors">
          {open ? "Hide the list" : `See all ${needs.length}`} {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
      </div>
      {!open && next && (
        <div className="mt-3 pt-3 border-t border-[var(--color-border)] flex items-center gap-3 flex-wrap" data-need-next={next.id}>
          <span className="min-w-0 flex-1 basis-56">
            <span className="block text-[12px] font-semibold text-[var(--color-text-muted)]">Next</span>
            <b className="block text-[13.5px] leading-snug text-[var(--color-text)]">{next.title}</b>
            <span className="block text-[12.5px] text-[var(--color-text-muted)]">{next.status}</span>
          </span>
          {go(next)}
        </div>
      )}
      {open && (
        <ol className="mt-3 grid lg:grid-cols-2 gap-px border-y border-[var(--color-border)] bg-[var(--color-border)] overflow-hidden">
          {needs.map((n) => (
            <li key={n.id} className="flex items-start gap-3 px-3 py-2.5 flex-wrap bg-[var(--color-surface)]" data-need={n.id} data-need-done={n.done ? "1" : "0"}>
              <span className={`mt-0.5 w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${n.done ? "bg-[color-mix(in_srgb,var(--state-released)_14%,transparent)] text-[var(--state-released)]" : "bg-[color-mix(in_srgb,var(--state-held)_14%,transparent)] text-[var(--state-held)]"}`}>
                {n.done ? <Check className="w-4 h-4" /> : <span className="text-[13px] font-semibold">!</span>}
              </span>
              <span className="min-w-0 flex-1 basis-40">
                <b className="block text-[13.5px] leading-snug text-[var(--color-text)]">{n.title}</b>
                <span className="block text-[12.5px] text-[var(--color-text-muted)]">{n.status}</span>
                <span className="block text-[12px] text-[var(--color-text-faint)]">{n.category}</span>
              </span>
              {go(n)}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
