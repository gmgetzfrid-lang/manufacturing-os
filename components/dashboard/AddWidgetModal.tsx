"use client";

import React, { useEffect, useState } from "react";
import { X, Plus, Check, Search } from "lucide-react";
import type { WidgetType } from "@/lib/dashboard/types";
import { WIDGET_CATALOG, type WidgetMeta } from "./widgets";
import { heroPrimary } from "@/components/ui/PageHero";

interface Props {
  open: boolean;
  onClose: () => void;
  existingTypes: WidgetType[];
  isAdmin: boolean;
  onAdd: (type: WidgetType) => void;
}

const ORDER: WidgetMeta["category"][] = ["Knowledge", "Documents", "Work", "You", "Admin"];

export default function AddWidgetModal({ open, onClose, existingTypes, isAdmin, onAdd }: Props) {
  const [q, setQ] = useState("");
  const [justAdded, setJustAdded] = useState<WidgetType | null>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  const term = q.trim().toLowerCase();
  const entries = Object.values(WIDGET_CATALOG)
    .filter((m) => !m.adminOnly || isAdmin)
    .filter((m) => !term || `${m.title} ${m.description} ${m.category}`.toLowerCase().includes(term));
  const count = (t: WidgetType) => existingTypes.filter((x) => x === t).length;

  return (
    <div role="dialog" aria-modal="true" aria-label="Add a widget" className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[color-mix(in_srgb,var(--color-ink)_58%,transparent)]" onClick={onClose} />
      <div className="relative w-full max-w-3xl bg-[var(--color-surface)] rounded-panel ui-float ui-float-in overflow-hidden max-h-[85vh] flex flex-col">
        <div className="px-6 py-4 border-b border-[var(--color-border)] flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-section font-semibold text-[var(--color-text)]">Add a widget</h2>
            <p className="mt-0.5 text-body text-[var(--color-text-muted)]">It goes at the bottom of your Home.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="w-9 h-9 pointer-coarse:w-11 pointer-coarse:h-11 grid place-items-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"><X className="w-5 h-5" /></button>
        </div>
        <div className="px-6 pt-3">
          <label className="ui-field-box flex items-center gap-2 rounded-lg border border-[var(--color-border-control)] px-3 h-10 pointer-coarse:h-11">
            <Search aria-hidden className="w-4 h-4 text-[var(--color-text-muted)]" />
            <input autoFocus type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a widget" aria-label="Find a widget"
              className="ui-field-bare flex-1 bg-transparent text-reading text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)]" />
          </label>
        </div>

        <div className="p-4 pt-3 overflow-y-auto space-y-4">
          {ORDER.map((cat) => {
            const list = entries.filter((m) => m.category === cat);
            if (list.length === 0) return null;
            return (
              <section key={cat}>
                <h3 className="pb-1.5 border-b border-[var(--color-border)] text-reading font-medium text-[var(--color-text)]">{cat}</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 sm:gap-x-6 divide-y divide-[var(--color-border)] sm:divide-y-0">
                  {list.map((m) => {
                    const n = count(m.type);
                    const blocked = n > 0 && !m.multi;
                    const Icon = m.icon;
                    return (
                      <button key={m.type} type="button" disabled={blocked}
                        onClick={() => { onAdd(m.type); setJustAdded(m.type); }}
                        className={`relative flex items-center gap-3 py-2.5 px-2 -mx-2 rounded-md text-left transition-colors sm:border-b sm:border-[var(--color-border)] ${
                          blocked ? "opacity-60 cursor-default" : "hover:bg-[var(--color-surface-2)]"}`}>
                        <Icon aria-hidden className="w-[18px] h-[18px] shrink-0 text-[var(--color-text-muted)]" />
                        <div className="min-w-0 flex-1">
                          <div className="text-reading font-medium text-[var(--color-text)]">{m.title}{m.isNew && <span className="ml-1.5 text-body font-normal text-[var(--color-text-muted)]">New</span>}</div>
                          <div className="text-body text-[var(--color-text-muted)] line-clamp-2">{m.description}</div>
                          {n > 0 && m.multi && <div className="text-body text-[var(--color-text)] mt-0.5">{n} on your Home. Select to add another.</div>}
                        </div>
                        {blocked ? (
                          <span className="inline-flex items-center gap-1.5 text-body font-medium text-[var(--color-text)] shrink-0"><span aria-hidden className="w-2 h-2 rounded-full bg-[var(--state-released)]" /> Added</span>
                        ) : justAdded === m.type ? (
                          <span className="inline-flex items-center gap-1.5 text-body font-medium text-[var(--color-text)] shrink-0"><Check className="w-4 h-4 text-[var(--state-released)]" /> Added</span>
                        ) : (
                          <span className="inline-flex items-center justify-center gap-1 h-8 px-2.5 rounded-lg border border-[var(--color-border-strong)] text-body font-medium text-[var(--color-text)] shrink-0"><Plus className="w-3.5 h-3.5" /> Add</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}
          {entries.length === 0 && <p className="text-reading text-[var(--color-text-muted)]">No widget matches “{q}”.</p>}
        </div>

        <div className="px-6 py-3 border-t border-[var(--color-border)] flex justify-end">
          <button type="button" onClick={onClose} className={heroPrimary}>Done</button>
        </div>
      </div>
    </div>
  );
}
