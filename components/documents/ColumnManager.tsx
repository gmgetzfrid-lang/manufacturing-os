"use client";

import React, { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Eye, EyeOff, X, Trash2, Pencil, Check, Loader2, KeyRound, GripVertical } from "lucide-react";

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
  /** Currently configured uniqueness-tuple field keys. Undefined =
   *  use the default (documentNumber). Empty array = no uniqueness. */
  uniquenessKeys?: string[];
  /** When set, the manager renders a "Uniqueness tuple" section that
   *  lets the user pick which columns make a document distinct from
   *  another in the same library. Applied with the Apply button. */
  onChangeUniquenessKeys?: (next: string[]) => Promise<void> | void;
}) {
  const { isOpen, onClose, columns, active, onChange, onDeleteColumn, onRenameColumn, isController, uniquenessKeys, onChangeUniquenessKeys } = props;
  const [draft, setDraft] = useState<string[]>(active);
  const initialUniq = useMemo(
    () => (uniquenessKeys && uniquenessKeys.length > 0 ? uniquenessKeys : ["documentNumber"]),
    [uniquenessKeys],
  );
  const [uniqDraft, setUniqDraft] = useState<string[]>(initialUniq);
  // Re-seed uniqDraft if the upstream prop changes while open.
  React.useEffect(() => { setUniqDraft(initialUniq); }, [initialUniq]);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [savingRename, setSavingRename] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  // Drag-drop reorder state. dragIndex = the item being dragged.
  // hoverIndex = where it would land if dropped. Both live indices
  // into `draft` (the visible-column order).
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

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

  const reorder = (from: number, to: number) => {
    if (from === to) return;
    setDraft((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  const toggleUniq = (key: string) => {
    setUniqDraft((prev) => prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]);
  };

  const apply = async () => {
    onChange(draft);
    if (onChangeUniquenessKeys) {
      const sameAsInitial =
        uniqDraft.length === initialUniq.length &&
        uniqDraft.every((k, i) => k === initialUniq[i]);
      if (!sameAsInitial) await onChangeUniquenessKeys(uniqDraft);
    }
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
            <div className="text-sm font-bold text-slate-900">Library Column Manager</div>
            <div className="text-xs text-slate-500">Add, rename, reorder, hide, or remove columns. Applies to every folder in this library.</div>
          </div>
          <button
            onClick={onClose}
            className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white hover:bg-slate-50"
          >
            <X className="h-4 w-4 text-slate-600" />
          </button>
        </div>

        {isController && onRenameColumn && (
          <div className="px-5 py-2 bg-blue-50/50 border-b border-blue-100 text-[11px] text-slate-700 flex items-start gap-2">
            <Pencil className="w-3 h-3 text-blue-600 mt-0.5 shrink-0" />
            <span>
              <b>Tip:</b> Every column has a <Pencil className="inline w-2.5 h-2.5 align-baseline" /> pencil to rename — including the built-in ones (e.g. <i>Doc No</i> → <i>Sheet No</i>). Renames affect the displayed label only, the underlying data is untouched.
            </span>
          </div>
        )}

        {onChangeUniquenessKeys && (
          <div className="px-5 pt-4 pb-3 border-b border-slate-100">
            <div className="flex items-center gap-2 mb-1">
              <KeyRound className="w-3.5 h-3.5 text-slate-600" />
              <span className="text-xs font-bold text-slate-700">What makes a document unique in this library?</span>
            </div>
            <div className="text-[11px] text-slate-500 mb-2">
              Pick the field(s) that, taken together, must be different for two documents to coexist. Default is just <i>Document Number</i>. Add <i>Sheet</i> to let many sheets share one number. Tick none to turn uniqueness off.
            </div>
            <div className="flex flex-wrap gap-1.5">
              {columns.map((col) => {
                const on = uniqDraft.includes(col.key);
                return (
                  <button
                    key={col.key}
                    onClick={() => toggleUniq(col.key)}
                    className={`px-2.5 py-1 rounded-full text-[11px] font-bold border transition ${
                      on
                        ? "bg-amber-100 border-amber-400 text-amber-900"
                        : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    {on ? "✓ " : ""}{col.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

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
                            className="shrink-0 p-2 rounded-lg border-2 border-blue-200 bg-blue-50 text-blue-600 hover:text-blue-800 hover:bg-blue-100 hover:border-blue-400 transition-colors"
                            title={`Rename "${col.label}" — works for built-in columns too`}
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
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs font-bold text-slate-500">Visible order</div>
              <div className="text-[10px] text-slate-400">Drag rows to reorder · arrows still work</div>
            </div>
            <div className="space-y-1 max-h-[320px] overflow-auto">
              {options.map((col, idx) => {
                const dragging = dragIndex === idx;
                const showAbove = hoverIndex === idx && dragIndex !== null && dragIndex > idx;
                const showBelow = hoverIndex === idx && dragIndex !== null && dragIndex < idx;
                return (
                  <div key={col.key} className="relative">
                    {showAbove && <div className="absolute -top-0.5 left-0 right-0 h-0.5 bg-blue-500 rounded-full" />}
                    <div
                      draggable
                      onDragStart={(e) => {
                        setDragIndex(idx);
                        e.dataTransfer.effectAllowed = "move";
                        // Required by Firefox so dragging fires.
                        e.dataTransfer.setData("text/plain", col.key);
                      }}
                      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (hoverIndex !== idx) setHoverIndex(idx); }}
                      onDragLeave={() => { if (hoverIndex === idx) setHoverIndex(null); }}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (dragIndex !== null && dragIndex !== idx) reorder(dragIndex, idx);
                        setDragIndex(null); setHoverIndex(null);
                      }}
                      onDragEnd={() => { setDragIndex(null); setHoverIndex(null); }}
                      className={`flex items-center justify-between rounded-lg border bg-white px-2 py-2 transition-all ${
                        dragging ? "opacity-40 border-blue-400" : "border-slate-200 hover:border-slate-300"
                      }`}
                    >
                      <div className="flex items-center min-w-0 gap-1.5">
                        <GripVertical className="h-4 w-4 text-slate-400 cursor-grab active:cursor-grabbing shrink-0" />
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-slate-900 truncate">{col.label}</div>
                          <div className="text-[11px] text-slate-500">{col.key}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-slate-200 hover:bg-slate-50 disabled:opacity-30"
                          onClick={() => move(idx, "up")}
                          disabled={idx === 0}
                          title="Move up"
                        >
                          <ChevronUp className="h-3.5 w-3.5" />
                        </button>
                        <button
                          className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-slate-200 hover:bg-slate-50 disabled:opacity-30"
                          onClick={() => move(idx, "down")}
                          disabled={idx === options.length - 1}
                          title="Move down"
                        >
                          <ChevronDown className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                    {showBelow && <div className="absolute -bottom-0.5 left-0 right-0 h-0.5 bg-blue-500 rounded-full" />}
                  </div>
                );
              })}
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
