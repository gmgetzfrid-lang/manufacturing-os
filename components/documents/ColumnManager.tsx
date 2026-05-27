"use client";

import React, { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Eye, EyeOff, X, Trash2, Pencil, Check, Loader2 } from "lucide-react";

export type ColumnOption = {
  key: string;
  label: string;
  locked?: boolean;
  /** Was the column user-created (custom) vs system? Locked columns are
   *  system. Custom columns can be renamed even if marked locked=false. */
  systemRenameOnly?: boolean;
};

export default function ColumnManager(props: {
  isOpen: boolean;
  onClose: () => void;
  columns: ColumnOption[];
  active: string[];
  onChange: (next: string[]) => void;
  onDeleteColumn?: (key: string) => Promise<void>;
  onRenameColumn?: (key: string, newLabel: string) => Promise<void>;
  isController?: boolean;
}) {
  const { isOpen, onClose, columns, active, onChange, onDeleteColumn, onRenameColumn, isController } = props;
  const [draft, setDraft] = useState<string[]>(active);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [savingRename, setSavingRename] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

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

  const startRename = (key: string, currentLabel: string) => {
    setEditingKey(key);
    setEditValue(currentLabel);
    setRenameError(null);
  };
  const cancelRename = () => { setEditingKey(null); setEditValue(""); setRenameError(null); };
  const saveRename = async () => {
    if (!editingKey || !onRenameColumn) {
      setRenameError(!onRenameColumn ? "Rename not enabled in this context" : "No column selected");
      return;
    }
    const trimmed = editValue.trim();
    if (!trimmed) { setRenameError("Name can't be blank"); return; }
    setSavingRename(true);
    setRenameError(null);
    try {
      await onRenameColumn(editingKey, trimmed);
      setEditingKey(null);
      setEditValue("");
    } catch (e) {
      const msg = (e as Error).message || "Rename failed";
      // Friendly error if the migration hasn't been run
      if (msg.includes("column_label_overrides") || msg.includes("does not exist")) {
        setRenameError(
          "Rename failed because the database needs a one-time migration. Ask your admin to run: " +
          "ALTER TABLE libraries ADD COLUMN IF NOT EXISTS column_label_overrides JSONB DEFAULT '{}';"
        );
      } else {
        setRenameError(msg);
      }
    } finally { setSavingRename(false); }
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
                const isEditing = editingKey === col.key;
                const canRename = isController && onRenameColumn;  // any column when controller; locked or not — admin freedom to rename system labels too
                return (
                  <div key={col.key} className={`flex items-center gap-1 ${isEditing ? "p-1.5 rounded-lg bg-blue-50 ring-1 ring-blue-200" : ""}`}>
                    {isEditing ? (
                      <>
                        <input
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void saveRename();
                            if (e.key === "Escape") cancelRename();
                          }}
                          autoFocus
                          disabled={savingRename}
                          className="flex-1 min-w-0 px-3 py-2 rounded-lg border border-blue-300 bg-white text-sm font-bold text-slate-900 outline-none focus:ring-2 focus:ring-blue-500"
                        />
                        <button
                          onClick={() => void saveRename()}
                          disabled={savingRename || !editValue.trim()}
                          className="shrink-0 p-2 rounded-lg border border-emerald-300 bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50"
                          title="Save"
                        >
                          {savingRename ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                        </button>
                        <button
                          onClick={cancelRename}
                          disabled={savingRename}
                          className="shrink-0 p-2 rounded-lg border border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
                          title="Cancel"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </>
                    ) : (
                      <>
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
                        {canRename && (
                          <button
                            onClick={() => startRename(col.key, col.label)}
                            className="shrink-0 p-2 rounded-lg border border-slate-200 bg-white text-slate-400 hover:text-blue-600 hover:bg-blue-50 hover:border-blue-200 transition-colors"
                            title={`Rename "${col.label}"`}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        )}
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
                      </>
                    )}
                  </div>
                );
              })}
              {renameError && (
                <div className="mt-3 p-3 bg-red-50 border-2 border-red-300 rounded-lg text-xs text-red-800 leading-relaxed font-medium">
                  <div className="font-black uppercase tracking-widest text-[10px] mb-1">Rename failed</div>
                  {renameError}
                </div>
              )}
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
