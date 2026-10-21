"use client";

import React, { useEffect, useState } from "react";
import { X, Plus, Check, Search } from "lucide-react";
import type { WidgetType } from "@/lib/dashboard/types";
import { WIDGET_CATALOG, toneChip, type WidgetMeta } from "./widgets";

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
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-3xl bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden max-h-[85vh] flex flex-col">
        <div className="px-6 py-4 border-b border-[var(--color-border)] flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-black text-[var(--color-text)]">Add a widget</h2>
            <p className="text-xs text-[var(--color-text-muted)]">Every widget can be renamed, refreshed, expanded full-size and configured from its ⚙.</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"><X className="w-5 h-5" /></button>
        </div>
        <div className="px-6 pt-3">
          <label className="flex items-center gap-2 rounded-xl border border-[var(--color-border)] px-3 h-10 focus-within:border-[var(--color-accent)]">
            <Search className="w-4 h-4 text-[var(--color-text-faint)]" />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a widget…"
              className="flex-1 bg-transparent text-sm text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)]" />
          </label>
        </div>

        <div className="p-4 pt-3 overflow-y-auto space-y-4">
          {ORDER.map((cat) => {
            const list = entries.filter((m) => m.category === cat);
            if (list.length === 0) return null;
            return (
              <section key={cat}>
                <h3 className="px-1 mb-1.5 text-[10px] font-black uppercase tracking-[0.14em] text-[var(--color-text-faint)]">{cat}</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {list.map((m) => {
                    const n = count(m.type);
                    const blocked = n > 0 && !m.multi;
                    const Icon = m.icon;
                    return (
                      <button key={m.type} type="button" disabled={blocked}
                        onClick={() => { onAdd(m.type); setJustAdded(m.type); }}
                        className={`relative flex items-center gap-3 p-3 rounded-xl border text-left transition-colors ${
                          blocked ? "border-[var(--color-border)] opacity-60 cursor-default" : "border-[var(--color-border)] hover:border-[var(--color-accent)] hover:bg-[var(--color-surface-2)]"}`}>
                        {m.isNew && <span className="absolute -top-1.5 right-3 px-1.5 py-0.5 rounded bg-[var(--color-accent)] text-white text-[9px] font-black uppercase tracking-wider">New</span>}
                        <span className={`inline-flex items-center justify-center w-10 h-10 rounded-xl ${toneChip(m.tone)} shrink-0`}><Icon className="w-5 h-5" /></span>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-bold text-[var(--color-text)]">{m.title}</div>
                          <div className="text-xs text-[var(--color-text-muted)] line-clamp-2">{m.description}</div>
                          {n > 0 && m.multi && <div className="text-[10px] font-bold text-emerald-600 mt-0.5">{n} on your dashboard — add another</div>}
                        </div>
                        {blocked ? (
                          <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600 shrink-0"><Check className="w-4 h-4" /> Added</span>
                        ) : justAdded === m.type ? (
                          <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-emerald-600 text-white shrink-0"><Check className="w-4 h-4" /></span>
                        ) : (
                          <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-[var(--color-accent)] text-white shrink-0"><Plus className="w-4 h-4" /></span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}
          {entries.length === 0 && <p className="text-sm text-[var(--color-text-muted)] px-1">No widget matches “{q}”.</p>}
        </div>

        <div className="px-6 py-3 border-t border-[var(--color-border)] flex justify-end">
          <button onClick={onClose} className="px-4 py-2 rounded-xl bg-[var(--color-surface-2)] border border-[var(--color-border)] text-sm font-bold text-[var(--color-text)] hover:bg-[var(--color-canvas)]">Done</button>
        </div>
      </div>
    </div>
  );
}
