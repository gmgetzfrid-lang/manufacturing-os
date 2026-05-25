"use client";

import React, { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Eye, EyeOff, X, Trash2 } from "lucide-react";

export type ColumnOption = {
  key: string;
  label: string;
  locked?: boolean;
};

export default function ColumnManager(props: {
  isOpen: boolean;
  onClose: () => void;
  columns: ColumnOption[];
  active: string[];
  onChange: (next: string[]) => void;
  onDeleteColumn?: (key: string) => Promise<void>;
  isController?: boolean;
}) {
  const { isOpen, onClose, columns, active, onChange, onDeleteColumn, isController } = props;
  const [draft, setDraft] = useState<string[]>(active);
  const [deleting, setDeleting] = useState<string | null>(null);

  const options = useMemo(() => {
    const map = new Map(columns.map((c) => [c.key, c]));
    return draft.map((key) => map.get(key)).filter(Boolean) as ColumnOption[];
  }, [columns, draft]);

  const toggle = (key: string, locked?: boolean) => {
    if (locked) return;
    setDraft((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  };

  const move = (idx: number, dir: "up" | "down") => {
    setDraft((prev) => {
      const next = [...prev];
      const swap = dir === "up" ? idx - 1 : idx + 1;
      if (swap < 0 || swap >= next.length) return prev;
      const tmp = next[idx];
      next[idx] = next[swap];
      next[swap] = tmp;
      return next;
    });
  };

  const apply = () => {
    onChange(draft);
    onClose();
  };

  const handleDelete = async (key: string, label: string) => {
    if (!onDeleteColumn) return;
    if (!confirm(`Delete the "${label}" column?\n\nThis removes the column definition from the library. Existing document values are kept in the database but won't be visible until the column is recreated.`)) return;
    setDeleting(key);
    try {
      await onDeleteColumn(key);
      setDraft((prev) => prev.filter((k) => k !== key));
    } finally {
      setDeleting(null);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/60 p-4">
      <div className="w-full max-w-2xl rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
          <div>
            <div className="text-sm font-bold text-slate-900">Column Manager</div>
            <div className="text-xs text-slate-500">Pick, order, and pin your table columns.</div>
          </div>
          <button
            onClick={onClose}
            className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white hover:bg-slate-50"
          >
            <X className="h-4 w-4 text-slate-600" />
          </button>
        </div>

        <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="border border-slate-200 rounded-xl p-3">
            <div className="text-xs font-bold text-slate-500 mb-2">Available columns</div>
            <div className="space-y-1 max-h-[320px] overflow-auto">
              {columns.map((col) => {
                const on = draft.includes(col.key);
                const isDeleting = deleting === col.key;
                return (
                  <div key={col.key} className="flex items-center gap-1">
                    <button
                      className={`flex-1 min-w-0 text-left px-3 py-2 rounded-lg border text-sm flex items-center justify-between ${
                        on
                          ? "border-slate-900 bg-slate-900 text-white"
                          : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                      } ${col.locked ? "opacity-60 cursor-not-allowed" : ""}`}
                      onClick={() => toggle(col.key, col.locked)}
                      disabled={col.locked}
                    >
                      <span className="truncate">{col.label}</span>
                      {on ? <Eye className="h-4 w-4 shrink-0" /> : <EyeOff className="h-4 w-4 shrink-0" />}
                    </button>
                    {/* Delete button — only for custom (non-locked) columns, Admin/DocCtrl only */}
                    {!col.locked && isController && onDeleteColumn && (
                      <button
                        onClick={() => handleDelete(col.key, col.label)}
                        disabled={isDeleting}
                        className="shrink-0 p-2 rounded-lg border border-red-200 bg-red-50 text-red-400 hover:bg-red-100 hover:text-red-600 transition-colors disabled:opacity-40"
                        title={`Delete "${col.label}" column`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="border border-slate-200 rounded-xl p-3">
            <div className="text-xs font-bold text-slate-500 mb-2">Visible order</div>
            <div className="space-y-2 max-h-[320px] overflow-auto">
              {options.map((col, idx) => (
                <div
                  key={col.key}
                  className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-900 truncate">{col.label}</div>
                    <div className="text-[11px] text-slate-500">{col.key}</div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      className="h-8 w-8 inline-flex items-center justify-center rounded-lg border border-slate-200 hover:bg-slate-50"
                      onClick={() => move(idx, "up")}
                    >
                      <ChevronUp className="h-4 w-4" />
                    </button>
                    <button
                      className="h-8 w-8 inline-flex items-center justify-center rounded-lg border border-slate-200 hover:bg-slate-50"
                      onClick={() => move(idx, "down")}
                    >
                      <ChevronDown className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="px-5 py-4 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-slate-200 bg-white text-sm font-bold text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            onClick={apply}
            className="px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-bold hover:bg-slate-800"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
