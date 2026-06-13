"use client";
import { useToast } from "@/components/providers/ToastProvider";

// ViewSelector — dropdown that lists saved views (admin + personal),
// applies the picked view's filter/sort/display config to the parent
// page, and lets the user save the current state as a new view.

import React, { useEffect, useState, useCallback } from "react";
import {
  Eye, ChevronDown, Save, Plus, Trash2, Star,
  Loader2, X, User as UserIcon,
} from "lucide-react";
import {
  listViews, createView, deleteView,
  type LibraryView, type ViewFilterConfig, type ViewSortConfig, type ViewDisplayConfig,
} from "@/lib/libraryViews";
import { appConfirm } from "@/components/providers/DialogProvider";

interface ViewSelectorProps {
  orgId: string;
  libraryId: string;
  userId: string;
  isAdmin: boolean;
  /** Current state of the page; used when saving a new view. */
  currentFilter: ViewFilterConfig;
  currentSort: ViewSortConfig;
  currentDisplay: ViewDisplayConfig;
  /** Called when user picks a view; parent should apply these states. */
  onApply: (filter: ViewFilterConfig, sort: ViewSortConfig, display: ViewDisplayConfig) => void;
}

export default function ViewSelector({
  orgId, libraryId, userId, isAdmin,
  currentFilter, currentSort, currentDisplay, onApply,
}: ViewSelectorProps) {
  const { showToast } = useToast();
  const [views, setViews] = useState<LibraryView[]>([]);
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!orgId || !libraryId || !userId) return;
    setLoading(true);
    try {
      const list = await listViews({ orgId, libraryId, userId });
      setViews(list);
      // Auto-apply default view on first load
      const def = list.find((v) => v.is_default);
      if (def && !activeViewId) {
        setActiveViewId(def.id);
        onApply(def.filter_config, def.sort_config, def.display_config);
      }
    } catch (e) {
      console.warn("Views load failed:", e);
    } finally { setLoading(false); }
  }, [orgId, libraryId, userId, activeViewId, onApply]);

  useEffect(() => { void refresh(); }, [refresh]);

  const apply = (v: LibraryView) => {
    setActiveViewId(v.id);
    onApply(v.filter_config, v.sort_config, v.display_config);
    setOpen(false);
  };

  const remove = async (id: string) => {
    if (!(await appConfirm({ title: "Delete view", message: "Delete this view?", tone: "danger" }))) return;
    try { await deleteView(id); void refresh(); } catch (e) { showToast({ type: "error", title: "Couldn't delete view", message: (e as Error).message }); }
  };

  const activeView = views.find((v) => v.id === activeViewId);
  const orgViews = views.filter((v) => v.scope === "org");
  const userViews = views.filter((v) => v.scope === "user");

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold text-slate-700 bg-white border border-slate-200 hover:border-slate-300 shadow-sm"
      >
        <Eye className="w-3 h-3 text-slate-500" />
        <span className="truncate max-w-[120px]">{activeView ? activeView.name : "Default View"}</span>
        <ChevronDown className="w-3 h-3 text-slate-400" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-1 w-64 bg-white rounded-xl border border-slate-200 shadow-xl z-50 overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            <div className="px-3 py-2 border-b border-slate-100">
              <div className="text-[10px] font-black uppercase tracking-widest text-slate-500">Views</div>
            </div>
            <div className="max-h-72 overflow-y-auto">
              {loading ? (
                <div className="p-3 text-xs text-slate-500 flex items-center gap-2">
                  <Loader2 className="w-3 h-3 animate-spin" /> Loading…
                </div>
              ) : (
                <>
                  {orgViews.length > 0 && (
                    <>
                      <div className="px-3 py-1 text-[9px] font-black uppercase tracking-widest text-slate-400 bg-slate-50">Admin Views</div>
                      {orgViews.map((v) => (
                        <ViewRow key={v.id} v={v} active={v.id === activeViewId} onApply={() => apply(v)} onDelete={isAdmin ? () => remove(v.id) : undefined} />
                      ))}
                    </>
                  )}
                  {userViews.length > 0 && (
                    <>
                      <div className="px-3 py-1 text-[9px] font-black uppercase tracking-widest text-slate-400 bg-slate-50">My Views</div>
                      {userViews.map((v) => (
                        <ViewRow key={v.id} v={v} active={v.id === activeViewId} onApply={() => apply(v)} onDelete={() => remove(v.id)} />
                      ))}
                    </>
                  )}
                  {views.length === 0 && (
                    <div className="p-3 text-[11px] text-slate-500 italic">
                      No saved views yet. Use <b>Save current view</b> below to create one.
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="border-t border-slate-100 p-1">
              <button
                onClick={() => { setShowSaveModal(true); setOpen(false); }}
                className="w-full inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-bold text-slate-700 hover:bg-slate-50"
              >
                <Plus className="w-3 h-3" /> Save current view…
              </button>
            </div>
          </div>
        </>
      )}

      {showSaveModal && (
        <SaveViewModal
          orgId={orgId}
          libraryId={libraryId}
          userId={userId}
          isAdmin={isAdmin}
          filterConfig={currentFilter}
          sortConfig={currentSort}
          displayConfig={currentDisplay}
          onClose={() => setShowSaveModal(false)}
          onSaved={() => { setShowSaveModal(false); void refresh(); }}
        />
      )}
    </div>
  );
}

function ViewRow({ v, active, onApply, onDelete }: {
  v: LibraryView; active: boolean; onApply: () => void; onDelete?: () => void;
}) {
  return (
    <div className={`flex items-center gap-2 px-3 py-2 hover:bg-slate-50 cursor-pointer ${active ? "bg-[var(--color-accent-soft)]" : ""}`} onClick={onApply}>
      {v.scope === "user" ? <UserIcon className="w-3 h-3 text-slate-400 shrink-0" /> : <Eye className="w-3 h-3 text-slate-400 shrink-0" />}
      <div className="flex-1 min-w-0">
        <div className="text-xs font-bold text-slate-900 truncate flex items-center gap-1">
          {v.name}
          {v.is_default && <Star className="w-3 h-3 text-amber-500 fill-amber-400" />}
        </div>
        {v.description && <div className="text-[10px] text-slate-500 truncate">{v.description}</div>}
      </div>
      {onDelete && (
        <button onClick={(e) => { e.stopPropagation(); onDelete(); }} className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded">
          <Trash2 className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}

function SaveViewModal({
  orgId, libraryId, userId, isAdmin,
  filterConfig, sortConfig, displayConfig,
  onClose, onSaved,
}: {
  orgId: string; libraryId: string; userId: string; isAdmin: boolean;
  filterConfig: ViewFilterConfig; sortConfig: ViewSortConfig; displayConfig: ViewDisplayConfig;
  onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState<"org" | "user">(isAdmin ? "org" : "user");
  const [isDefault, setIsDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!name.trim()) { setError("Name required"); return; }
    setBusy(true); setError(null);
    try {
      await createView({
        orgId, libraryId, name: name.trim(),
        description: description.trim() || undefined,
        scope, ownerUserId: scope === "user" ? userId : undefined,
        filterConfig, sortConfig, displayConfig,
        isDefault, createdBy: userId,
      });
      onSaved();
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[400] bg-slate-900/60 backdrop-blur-sm animate-in fade-in flex items-start sm:items-center justify-center overflow-y-auto p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden animate-in fade-in zoom-in-95">
        <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between">
          <div className="text-sm font-black text-slate-900 flex items-center gap-2">
            <Save className="w-4 h-4 text-[var(--color-accent)]" /> Save current view
          </div>
          <button onClick={onClose} disabled={busy} className="p-1.5 rounded text-slate-400 hover:text-slate-900 hover:bg-slate-100">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div>
            <label className="text-[10px] font-black text-slate-700 uppercase tracking-widest">Name *</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Past Due P&IDs" autoFocus className="mt-1 w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" />
          </div>
          <div>
            <label className="text-[10px] font-black text-slate-700 uppercase tracking-widest">Description</label>
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" className="mt-1 w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" />
          </div>
          <div>
            <label className="text-[10px] font-black text-slate-700 uppercase tracking-widest">Visibility</label>
            <div className="mt-1 flex bg-slate-100 p-1 rounded-lg w-fit">
              {isAdmin && (
                <button onClick={() => setScope("org")} className={`px-3 py-1.5 text-xs font-bold rounded-md ${scope === "org" ? "bg-white shadow text-slate-900" : "text-slate-500"}`}>
                  Org-wide
                </button>
              )}
              <button onClick={() => setScope("user")} className={`px-3 py-1.5 text-xs font-bold rounded-md ${scope === "user" ? "bg-white shadow text-slate-900" : "text-slate-500"}`}>
                Personal
              </button>
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
            Set as default {scope === "org" ? "for the team" : "for me"}
          </label>
          {error && <div className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded p-2">{error}</div>}
        </div>
        <div className="px-5 py-3 bg-slate-50 border-t border-slate-200 flex items-center justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="px-3 py-2 rounded-lg text-xs font-bold text-slate-700 bg-white border border-slate-200">Cancel</button>
          <button onClick={save} disabled={busy || !name.trim()} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-black text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50 shadow">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save view
          </button>
        </div>
      </div>
    </div>
  );
}
