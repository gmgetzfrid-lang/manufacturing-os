"use client";

// CollectionModal — single component that does view + create + edit.
//
// Modes:
//   create — empty form, scope picker, save creates the collection
//   view   — header + items list. Click "Edit" to enter edit mode.
//   edit   — same form as create but with existing values; +/− doc
//            management; reorder items.
//
// Drag-reorder is intentionally simple (move-up / move-down arrows)
// to avoid the complexity + bundle weight of a drag-drop library.

import React, { useEffect, useState, useCallback, useMemo } from "react";
import {
  X, Save, Trash2, Plus, ArrowUp, ArrowDown, Edit3, ListChecks,
  Loader2, AlertTriangle, FileText, Search, Pin, User as UserIcon,
  BookOpen,
} from "lucide-react";
import {
  type CuratedCollection, type CuratedCollectionItem,
  createCollection, updateCollection, deleteCollection,
  listItems, addItem, removeItem, reorderItems,
} from "@/lib/collections";
import { supabase } from "@/lib/supabase";
import { appConfirm } from "@/components/providers/DialogProvider";

type Mode = "create" | "view" | "edit";

interface LibraryDoc {
  id: string;
  documentNumber: string;
  title: string;
  rev?: string;
  status?: string;
}

interface CollectionModalProps {
  mode: Mode;
  collectionId?: string;
  orgId: string;
  libraryId: string;
  userId: string;
  isAdmin: boolean;
  libraryDocs: LibraryDoc[];
  onClose: () => void;
  onChanged: () => void;
  /** Open the collection as a unified book in MultiDocViewer. The parent
   *  page is responsible for hydrating the doc IDs into full DocumentRecord
   *  objects (it already has them in state) and mounting the viewer. */
  onOpenAsBook?: (docIds: string[]) => void;
}

export default function CollectionModal({
  mode: initialMode, collectionId, orgId, libraryId, userId, isAdmin,
  libraryDocs, onClose, onChanged, onOpenAsBook,
}: CollectionModalProps) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [collection, setCollection] = useState<CuratedCollection | null>(null);
  const [items, setItems] = useState<CuratedCollectionItem[]>([]);
  const [loading, setLoading] = useState(initialMode !== "create");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState<"org" | "user">(isAdmin ? "org" : "user");
  const [pinned, setPinned] = useState(true);

  // Doc picker
  const [showPicker, setShowPicker] = useState(false);
  const [pickerSearch, setPickerSearch] = useState("");

  // Load existing collection
  const load = useCallback(async () => {
    if (!collectionId) return;
    setLoading(true);
    try {
      const { data } = await supabase.from("curated_collections").select("*").eq("id", collectionId).maybeSingle();
      if (data) {
        const c = data as CuratedCollection;
        setCollection(c);
        setName(c.name);
        setDescription(c.description || "");
        setScope(c.scope);
        setPinned(c.pinned);
      }
      const its = await listItems(collectionId);
      setItems(its);
    } catch (e) {
      setError((e as Error).message);
    } finally { setLoading(false); }
  }, [collectionId]);

  useEffect(() => { void load(); }, [load]);

  // Escape always gets you out — closes the doc picker first if it's open,
  // otherwise closes the modal. A modal must never trap the user.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (showPicker) setShowPicker(false);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showPicker, onClose]);

  const isOwner = collection?.scope === "user"
    ? collection.owner_user_id === userId
    : isAdmin;

  const canEdit = mode === "create" ? true : isOwner;

  // ── Save form (create or edit) ────────────────────────────────
  const save = async () => {
    if (!name.trim()) { setError("Name required"); return; }
    setError(null); setBusy(true);
    try {
      if (mode === "create") {
        const c = await createCollection({
          orgId, libraryId, name: name.trim(), description: description.trim() || undefined,
          scope, ownerUserId: scope === "user" ? userId : undefined,
          pinned, createdBy: userId,
        });
        setCollection(c);
        setMode("edit");
        onChanged();
      } else if (collection) {
        await updateCollection(collection.id, {
          name: name.trim(),
          description: description.trim() || null,
          pinned,
        }, userId);
        setMode("view");
        onChanged();
        void load();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  const onDelete = async () => {
    if (!collection) return;
    if (!(await appConfirm({ title: "Delete collection", message: "Delete this collection? Documents themselves aren't deleted, only the curated grouping.", tone: "danger" }))) return;
    setBusy(true);
    try {
      await deleteCollection(collection.id);
      onChanged();
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  // ── Item operations ───────────────────────────────────────────
  const onAddDoc = async (docId: string) => {
    if (!collection) return;
    setBusy(true);
    try {
      await addItem({ collectionId: collection.id, documentId: docId, addedBy: userId });
      const its = await listItems(collection.id);
      setItems(its);
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  const onRemoveDoc = async (docId: string) => {
    if (!collection) return;
    setBusy(true);
    try {
      await removeItem(collection.id, docId);
      setItems(items.filter((it) => it.document_id !== docId));
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  const onMove = async (docId: string, dir: -1 | 1) => {
    if (!collection) return;
    const order = items.map((it) => it.document_id);
    const idx = order.indexOf(docId);
    if (idx < 0) return;
    const target = idx + dir;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    [next[idx], next[target]] = [next[target], next[idx]];
    setItems(next.map((id, i) => {
      const orig = items.find((it) => it.document_id === id)!;
      return { ...orig, sort_order: i };
    }));
    setBusy(true);
    try {
      await reorderItems(collection.id, next);
    } catch (e) {
      setError((e as Error).message);
      void load();
    } finally { setBusy(false); }
  };

  // Resolve doc info for display
  const docMap = useMemo(() => {
    const m = new Map<string, LibraryDoc>();
    for (const d of libraryDocs) m.set(d.id, d);
    return m;
  }, [libraryDocs]);

  const itemsHydrated = items.map((it) => ({
    item: it,
    doc: docMap.get(it.document_id),
  }));

  // Doc picker list: docs not already in collection, filtered by search
  const availableDocs = useMemo(() => {
    const have = new Set(items.map((i) => i.document_id));
    const q = pickerSearch.trim().toLowerCase();
    return libraryDocs.filter((d) => {
      if (have.has(d.id)) return false;
      if (!q) return true;
      return d.documentNumber.toLowerCase().includes(q) || d.title.toLowerCase().includes(q);
    });
  }, [libraryDocs, items, pickerSearch]);

  // ── Render ────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-[300] bg-slate-900/60 backdrop-blur-sm animate-in fade-in flex items-center justify-center p-4 overflow-y-auto">
      <div className="w-full max-w-2xl bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden my-8 flex flex-col max-h-[90vh] animate-in fade-in zoom-in-95">
        {/* Header */}
        <div className="px-6 py-4 border-b border-[var(--color-border)] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className={`p-2 rounded-lg shrink-0 ${scope === "org" ? "bg-purple-100" : "bg-[var(--color-surface-2)]"}`}>
              <ListChecks className={`w-5 h-5 ${scope === "org" ? "text-purple-700" : "text-[var(--color-text-muted)]"}`} />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-black text-[var(--color-text)] truncate">
                {mode === "create" ? "New Collection" : (collection?.name ?? "Collection")}
              </div>
              <div className="text-xs text-[var(--color-text-muted)] truncate">
                {scope === "org" ? "Visible to everyone in your org" : "Personal — only you can see this"}
              </div>
            </div>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-faint)] hover:text-[var(--color-text)]">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="p-8 text-center text-sm text-[var(--color-text-muted)]"><Loader2 className="w-4 h-4 animate-spin inline" /> Loading…</div>
          ) : (
            <>
              {/* Form (create + edit) */}
              {(mode === "create" || mode === "edit") && (
                <div className="p-6 space-y-4 border-b border-[var(--color-border)]">
                  <Field label="Name *">
                    <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Crude Cold Side — Receipt to Surge" className="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm" />
                  </Field>
                  <Field label="Description" hint="Optional. Describe what this collection is for.">
                    <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="e.g. P&IDs and isos for crude unit cold side, in flow order." className="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm resize-y" />
                  </Field>
                  {mode === "create" && (
                    <Field label="Visibility">
                      <div className="flex bg-[var(--color-surface-2)] p-1 rounded-lg w-fit">
                        {isAdmin && (
                          <button onClick={() => setScope("org")} className={`px-3 py-1.5 text-xs font-bold rounded-md ${scope === "org" ? "bg-[var(--color-surface)] shadow text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>
                            Org-wide
                          </button>
                        )}
                        <button onClick={() => setScope("user")} className={`px-3 py-1.5 text-xs font-bold rounded-md flex items-center gap-1 ${scope === "user" ? "bg-[var(--color-surface)] shadow text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>
                          <UserIcon className="w-3 h-3" /> Personal
                        </button>
                      </div>
                    </Field>
                  )}
                  <label className="flex items-center gap-2 text-xs">
                    <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
                    <Pin className="w-3.5 h-3.5 text-[var(--color-text-muted)]" /> Pin to top of library
                  </label>
                </div>
              )}

              {/* View / Items list */}
              {(mode === "view" || mode === "edit") && collection && (
                <div className="p-6">
                  {mode === "view" && collection.description && (
                    <p className="text-sm text-[var(--color-text-muted)] mb-4 leading-relaxed">{collection.description}</p>
                  )}

                  <div className="flex items-center justify-between mb-2">
                    <div className="text-[10px] font-black text-[var(--color-text-muted)] uppercase tracking-widest">
                      Documents ({itemsHydrated.length})
                    </div>
                    {mode === "edit" && (
                      <button onClick={() => setShowPicker(true)} className="inline-flex items-center gap-1 text-[11px] font-bold text-purple-700 hover:text-purple-800">
                        <Plus className="w-3 h-3" /> Add documents
                      </button>
                    )}
                  </div>

                  {itemsHydrated.length === 0 ? (
                    <div className="text-center text-xs text-[var(--color-text-faint)] italic py-8 border border-dashed border-[var(--color-border)] rounded-lg">
                      No documents in this collection yet.
                      {mode === "edit" && <> Click <b>Add documents</b> to pick some.</>}
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {itemsHydrated.map(({ item, doc }, idx) => (
                        <div key={item.document_id} className="bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-lg px-3 py-2 flex items-center gap-2">
                          <span className="text-[10px] font-mono text-[var(--color-text-faint)] w-5 text-right">{idx + 1}.</span>
                          <FileText className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                          <div className="flex-1 min-w-0">
                            {doc ? (
                              <>
                                <div className="text-xs font-bold text-[var(--color-text)] truncate">{doc.documentNumber}</div>
                                <div className="text-[11px] text-[var(--color-text-muted)] truncate">{doc.title}</div>
                              </>
                            ) : (
                              <div className="text-xs text-[var(--color-text-faint)] italic">(Document removed or no longer accessible)</div>
                            )}
                          </div>
                          {doc?.rev && (
                            <span className="text-[10px] font-bold text-[var(--color-text-muted)] shrink-0">Rev {doc.rev}</span>
                          )}
                          {mode === "edit" && (
                            <div className="flex items-center gap-0.5 shrink-0">
                              <button onClick={() => onMove(item.document_id, -1)} disabled={idx === 0 || busy} className="p-1 text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-slate-200 rounded disabled:opacity-30">
                                <ArrowUp className="w-3 h-3" />
                              </button>
                              <button onClick={() => onMove(item.document_id, 1)} disabled={idx === itemsHydrated.length - 1 || busy} className="p-1 text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-slate-200 rounded disabled:opacity-30">
                                <ArrowDown className="w-3 h-3" />
                              </button>
                              <button onClick={() => onRemoveDoc(item.document_id)} disabled={busy} className="p-1 text-[var(--color-text-faint)] hover:text-red-600 hover:bg-red-50 rounded">
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Doc picker overlay */}
              {showPicker && collection && (
                <div className="fixed inset-0 z-[310] bg-slate-900/60 backdrop-blur-sm animate-in fade-in flex items-start sm:items-center justify-center overflow-y-auto p-4">
                  <div className="w-full max-w-lg bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden flex flex-col max-h-[80vh] animate-in fade-in zoom-in-95">
                    <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center justify-between">
                      <div className="text-sm font-black text-[var(--color-text)]">Add documents</div>
                      <button onClick={() => setShowPicker(false)} className="p-1.5 rounded text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <div className="px-4 py-2 border-b border-[var(--color-border)]">
                      <div className="flex items-center gap-2 bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-lg px-2 py-1.5">
                        <Search className="w-3.5 h-3.5 text-[var(--color-text-faint)]" />
                        <input value={pickerSearch} onChange={(e) => setPickerSearch(e.target.value)} placeholder="Search document #, title…" className="flex-1 bg-transparent text-xs outline-none" />
                      </div>
                    </div>
                    <div className="flex-1 overflow-y-auto p-2">
                      {availableDocs.length === 0 ? (
                        <div className="text-center text-xs text-[var(--color-text-faint)] py-8">No matches.</div>
                      ) : (
                        availableDocs.map((d) => (
                          <button
                            key={d.id}
                            onClick={() => void onAddDoc(d.id)}
                            disabled={busy}
                            className="w-full text-left flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-[var(--color-surface-2)] disabled:opacity-50"
                          >
                            <FileText className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                            <div className="flex-1 min-w-0">
                              <div className="text-xs font-bold text-[var(--color-text)] truncate">{d.documentNumber}</div>
                              <div className="text-[11px] text-[var(--color-text-muted)] truncate">{d.title}</div>
                            </div>
                            {d.rev && <span className="text-[10px] text-[var(--color-text-faint)]">Rev {d.rev}</span>}
                            <Plus className="w-3.5 h-3.5 text-[var(--color-text-faint)]" />
                          </button>
                        ))
                      )}
                    </div>
                    <div className="px-4 py-2 border-t border-[var(--color-border)] bg-[var(--color-surface-2)] text-right">
                      <button onClick={() => setShowPicker(false)} className="text-xs font-bold text-[var(--color-text)] px-3 py-1.5 rounded hover:bg-[var(--color-surface-2)]">Done</button>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {error && (
          <div className="px-6 py-2 bg-red-50 border-t border-red-200 text-xs text-red-700 flex items-start gap-2 shrink-0">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {error}
          </div>
        )}

        {/* Footer actions */}
        <div className="px-6 py-3 bg-[var(--color-surface-2)] border-t border-[var(--color-border)] flex items-center justify-between shrink-0">
          <div>
            {mode === "view" && canEdit && collection && (
              <button onClick={onDelete} disabled={busy} className="text-xs font-bold text-red-600 hover:text-red-700 inline-flex items-center gap-1">
                <Trash2 className="w-3 h-3" /> Delete collection
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border)] hover:bg-[var(--color-surface-2)]">
              {mode === "view" ? "Close" : "Cancel"}
            </button>
            {mode === "view" && onOpenAsBook && items.length > 0 && (
              <button
                onClick={() => {
                  onOpenAsBook(items.map((it) => it.document_id).filter(Boolean));
                  onClose();
                }}
                title="Open every document in this collection as a single book in the multi-doc viewer."
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-white bg-blue-600 hover:bg-blue-500 shadow"
              >
                <BookOpen className="w-3.5 h-3.5" /> Open as Book
              </button>
            )}
            {mode === "view" && canEdit && (
              <button onClick={() => setMode("edit")} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-white bg-purple-600 hover:bg-purple-500 shadow">
                <Edit3 className="w-3.5 h-3.5" /> Edit
              </button>
            )}
            {(mode === "create" || mode === "edit") && (
              <button onClick={save} disabled={busy || !name.trim()} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-black text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 shadow">
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                {mode === "create" ? "Create" : "Save"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest">{label}</label>
      {hint && <div className="text-[10px] text-[var(--color-text-muted)] mt-0.5">{hint}</div>}
      <div className="mt-1">{children}</div>
    </div>
  );
}
