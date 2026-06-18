"use client";

import React from "react";
import { X, Plus, Check } from "lucide-react";
import type { WidgetType } from "@/lib/dashboard/types";
import { WIDGET_CATALOG, toneChip } from "./widgets";

interface Props {
  open: boolean;
  onClose: () => void;
  existingTypes: WidgetType[];
  isAdmin: boolean;
  onAdd: (type: WidgetType) => void;
}

export default function AddWidgetModal({ open, onClose, existingTypes, isAdmin, onAdd }: Props) {
  if (!open) return null;
  const entries = Object.values(WIDGET_CATALOG).filter((m) => !m.adminOnly || isAdmin);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)]">
          <div>
            <h2 className="text-base font-black text-[var(--color-text)]">Add a widget</h2>
            <p className="text-xs text-[var(--color-text-muted)]">Pick a tool to surface on your dashboard.</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-3 overflow-y-auto">
          <div className="grid grid-cols-1 gap-2">
            {entries.map((m) => {
              const added = existingTypes.includes(m.type);
              const Icon = m.icon;
              return (
                <button
                  key={m.type}
                  type="button"
                  disabled={added}
                  onClick={() => onAdd(m.type)}
                  className={`flex items-center gap-3 p-3 rounded-xl border text-left transition-colors ${
                    added
                      ? "border-[var(--color-border)] opacity-60 cursor-default"
                      : "border-[var(--color-border)] hover:border-[var(--color-accent)] hover:bg-[var(--color-surface-2)]"
                  }`}
                >
                  <span className={`inline-flex items-center justify-center w-10 h-10 rounded-xl ${toneChip(m.tone)} shrink-0`}>
                    <Icon className="w-5 h-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-bold text-[var(--color-text)]">{m.title}</div>
                    <div className="text-xs text-[var(--color-text-muted)] truncate">{m.description}</div>
                  </div>
                  {added ? (
                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600 shrink-0">
                      <Check className="w-4 h-4" /> Added
                    </span>
                  ) : (
                    <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-[var(--color-accent)] text-white shrink-0">
                      <Plus className="w-4 h-4" />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="px-6 py-3 border-t border-[var(--color-border)] flex justify-end">
          <button onClick={onClose} className="px-4 py-2 rounded-xl bg-[var(--color-surface-2)] border border-[var(--color-border)] text-sm font-bold text-[var(--color-text)] hover:bg-[var(--color-canvas)]">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
