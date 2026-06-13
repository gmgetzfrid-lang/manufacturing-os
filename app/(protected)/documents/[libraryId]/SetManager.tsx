"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  X,
  Plus,
  Layers,
  Trash2,
  BookOpen,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Search,
  ArrowUp,
  ArrowDown,
  Settings,
  Folder,
  FileText,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { DocumentRecord, DocumentSet, Role } from "@/types/schema";
import { useRole } from "@/components/providers/RoleContext";
import { appConfirm } from "@/components/providers/DialogProvider";

interface SetManagerProps {
  isOpen: boolean;
  onClose: () => void;
  libraryId: string;
}

/**
 * Document Sets / Binders
 * - Controllers (Admin/DocCtrl) manage sets and membership
 * - Everyone else can view read-only
 *
 * Data model assumptions (compatible with your schema + rules intent):
 * - documentSets/{setId}: { title, libraryId, currentSetRev, sheetCount, updatedAt, ... }
 * - documents/{docId}: { libraryId, documentNumber, title, rev, status, setId?, sheetNumber?, sheetTotal? }
 */
export default function SetManager({ isOpen, onClose, libraryId }: SetManagerProps) {
  const { activeRole, loading: roleLoading } = useRole();

  const isController = useMemo(() => {
    const r = (activeRole || "Requester") as Role;
    return r === "Admin" || r === "DocCtrl";
  }, [activeRole]);

  // Data state
  const [sets, setSets] = useState<DocumentSet[]>([]);
  const [activeSet, setActiveSet] = useState<DocumentSet | null>(null);
  const [setDocs, setSetDocs] = useState<DocumentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [docsLoading, setDocsLoading] = useState(false);

  // UI state
  const [mode, setMode] = useState<"list" | "create" | "edit">("list");
  const [newSetTitle, setNewSetTitle] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");

  const [searchTerm, setSearchTerm] = useState("");
  const [searchResults, setSearchResults] = useState<DocumentRecord[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  const [toast, setToast] = useState<{ type: "success" | "error" | "info"; msg: string } | null>(null);
  const toastTimer = useRef<number | null>(null);

  const closeToast = () => {
    setToast(null);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = null;
  };

  const showToast = (t: { type: "success" | "error" | "info"; msg: string }) => {
    setToast(t);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2800);
  };

  const resetUI = () => {
    setMode("list");
    setActiveSet(null);
    setSetDocs([]);
    setNewSetTitle("");
    setSearchTerm("");
    setSearchResults([]);
    setSearchLoading(false);
    setEditingTitle(false);
    setTitleDraft("");
  };

  // --- LOAD SET LIST ---
  useEffect(() => {
    if (!isOpen) return;
    void (async () => {
      resetUI();
      await fetchSets();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, libraryId]);

  const fromSetRow = (r: Record<string, unknown>): DocumentSet => ({
    id: r.id as string, libraryId: r.library_id as string, title: r.title as string,
    currentSetRev: r.current_set_rev as string, sheetCount: r.sheet_count as number,
    assetIndex: r.asset_index as unknown as Record<string, string[]>,
  });

  const fromDocRow = (r: Record<string, unknown>): DocumentRecord => ({
    id: r.id as string, orgId: r.org_id as string, libraryId: r.library_id as string,
    documentNumber: r.document_number as string, title: r.title as string,
    rev: r.rev as string, status: r.status as DocumentRecord['status'],
    setId: r.set_id as string | undefined, sheetNumber: r.sheet_number as number | undefined,
    sheetTotal: r.sheet_total as number | undefined,
    createdAt: r.created_at as unknown as DocumentRecord['createdAt'],
    createdBy: (r.created_by as string) ?? '',
  });

  const fetchSets = async () => {
    setLoading(true);
    try {
      const { data } = await supabase.from("document_sets").select("*").eq("library_id", libraryId);
      const next = (data || []).map(r => fromSetRow(r as Record<string, unknown>))
        .sort((a, b) => (a.title || "").localeCompare(b.title || ""));
      setSets(next);
    } catch (e) {
      console.error("Failed to load sets", e);
      showToast({ type: "error", msg: "Failed to load binders." });
    } finally {
      setLoading(false);
    }
  };

  // --- LOAD SET CONTENT ---
  const loadSetDocs = async (set: DocumentSet) => {
    setDocsLoading(true);
    try {
      const { data } = await supabase.from("documents").select("*").eq("set_id", set.id).order("sheet_number", { ascending: true });
      const docs = (data || []).map(r => fromDocRow(r as Record<string, unknown>));
      docs.sort((a, b) => (Number(a.sheetNumber) || 0) - (Number(b.sheetNumber) || 0));
      setSetDocs(docs);
    } catch (e) {
      console.error("Failed to load set docs", e);
      showToast({ type: "error", msg: "Failed to load binder contents." });
    } finally {
      setDocsLoading(false);
    }
  };

  const selectSet = async (set: DocumentSet) => {
    setActiveSet(set);
    setMode("edit");
    setSearchTerm("");
    setSearchResults([]);
    setEditingTitle(false);
    setTitleDraft(set.title || "");
    await loadSetDocs(set);
  };

  // --- CREATE SET ---
  const handleCreateSet = async () => {
    if (!isController) {
      showToast({ type: "error", msg: "Read-only: Admin/DocCtrl only." });
      return;
    }
    const title = newSetTitle.trim();
    if (!title) return;

    try {
      await supabase.from("document_sets").insert({
        title, library_id: libraryId, current_set_rev: "0", sheet_count: 0, asset_index: {},
      });
      showToast({ type: "success", msg: "Binder created." });
      setNewSetTitle("");
      setMode("list");
      await fetchSets();
    } catch (e) {
      console.error(e);
      showToast({ type: "error", msg: "Failed to create binder (permissions or network)." });
    }
  };

  // --- RENAME SET ---
  const saveTitle = async () => {
    if (!activeSet) return;
    if (!isController) {
      showToast({ type: "error", msg: "Read-only: Admin/DocCtrl only." });
      return;
    }
    const nextTitle = titleDraft.trim();
    if (!nextTitle) return;

    try {
      await supabase.from("document_sets").update({ title: nextTitle }).eq("id", activeSet.id!);
      const next = { ...activeSet, title: nextTitle };
      setActiveSet(next);
      setSets((prev) => prev.map((s) => (s.id === next.id ? next : s)).sort((a, b) => (a.title || "").localeCompare(b.title || "")));
      setEditingTitle(false);
      showToast({ type: "success", msg: "Binder renamed." });
    } catch (e) {
      console.error(e);
      showToast({ type: "error", msg: "Failed to rename binder." });
    }
  };

  // --- SEARCH DOCS (prefix on documentNumber) ---
  const handleSearchDocs = async (term: string) => {
    const t = term.toUpperCase();
    setSearchTerm(term);

    if (!t || t.trim().length < 3) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }

    setSearchLoading(true);
    try {
      const { data } = await supabase.from("documents").select("id, document_number, title, rev, status, set_id, sheet_number, sheet_total")
        .eq("library_id", libraryId).ilike("document_number", `${t}%`).order("document_number").limit(12);
      const results = (data || []).map(r => fromDocRow(r as Record<string, unknown>));
      setSearchResults(results);
    } catch (e) {
      console.error(e);
      showToast({ type: "error", msg: "Search failed." });
    } finally {
      setSearchLoading(false);
    }
  };

  // --- MEMBERSHIP MUTATIONS ---
  const refreshActiveSet = async (setId: string) => {
    const { data } = await supabase.from("document_sets").select("*").eq("id", setId).single();
    if (!data) return;
    const next = fromSetRow(data as Record<string, unknown>);
    setActiveSet(next);
    setSets((prev) => prev.map((x) => (x.id === next.id ? next : x)));
    await loadSetDocs(next);
  };

  const bestEffortUpdateSheetTotals = async (setId: string, total: number) => {
    try {
      const { data } = await supabase.from("documents").select("id").eq("set_id", setId);
      if (!data || data.length > 200) return;
      await Promise.all(data.map(d => supabase.from("documents").update({ sheet_total: total }).eq("id", d.id)));
    } catch (e) {
      console.warn("sheetTotal best-effort update failed", e);
    }
  };

  const addToSet = async (docRecord: DocumentRecord) => {
    if (!activeSet) return;
    if (!isController) {
      showToast({ type: "error", msg: "Read-only: Admin/DocCtrl only." });
      return;
    }

    // Prevent duplicates locally
    if (setDocs.some((d) => d.id === docRecord.id)) {
      showToast({ type: "info", msg: "That document is already in this binder." });
      return;
    }

    try {
      const [setRes, docRes] = await Promise.all([
        supabase.from("document_sets").select("sheet_count").eq("id", activeSet.id!).single(),
        supabase.from("documents").select("id, set_id").eq("id", docRecord.id!).single(),
      ]);
      if (!setRes.data) throw new Error("Set not found.");
      if (!docRes.data) throw new Error("Document not found.");
      const existingSetId = (docRes.data as Record<string, unknown>).set_id;
      if (existingSetId && existingSetId !== activeSet.id) {
        throw new Error("This document is already assigned to a different binder.");
      }
      const nextSeq = ((setRes.data as Record<string, unknown>).sheet_count as number || 0) + 1;
      await supabase.from("documents").update({ set_id: activeSet.id, sheet_number: nextSeq, sheet_total: nextSeq }).eq("id", docRecord.id!);
      await supabase.from("document_sets").update({ sheet_count: nextSeq }).eq("id", activeSet.id!);

      showToast({ type: "success", msg: "Added to binder." });

      // Refresh state
      await refreshActiveSet(activeSet.id!);
      await bestEffortUpdateSheetTotals(activeSet.id!, (activeSet.sheetCount || 0) + 1);

      setSearchTerm("");
      setSearchResults([]);
    } catch (e: unknown) {
      const msg = (e as { message?: string })?.message;
      console.error(e);
      showToast({
        type: "error",
        msg: msg || "Failed to add document to binder.",
      });
    }
  };

  const resequenceAndCommit = async (setId: string, remaining: DocumentRecord[]) => {
    // remaining already excludes the removed doc, in desired order
    const total = remaining.length;

    // Chunked batches for safety
    const updates: Array<{ id: string; sheetNumber: number; sheetTotal: number }> = remaining.map((d, idx) => ({
      id: d.id!,
      sheetNumber: idx + 1,
      sheetTotal: total,
    }));

    // 1) Update all documents
    await Promise.all(updates.map(u =>
      supabase.from("documents").update({ sheet_number: u.sheetNumber, sheet_total: u.sheetTotal }).eq("id", u.id)
    ));
    await supabase.from("document_sets").update({ sheet_count: total }).eq("id", setId);
  };

  const removeFromSet = async (docRecord: DocumentRecord) => {
    if (!activeSet) return;
    if (!isController) {
      showToast({ type: "error", msg: "Read-only: Admin/DocCtrl only." });
      return;
    }

    const ok = await appConfirm({ title: `Remove ${docRecord.documentNumber || "this document"} from binder?`, tone: "danger" });
    if (!ok) return;

    try {
      await supabase.from("documents").update({ set_id: null, sheet_number: null, sheet_total: null }).eq("id", docRecord.id!);

      // Resequence remaining docs (authoritative from current UI order)
      const remaining = setDocs
        .filter((d) => d.id !== docRecord.id)
        .sort((a, b) => (Number(a.sheetNumber) || 0) - (Number(b.sheetNumber) || 0));

      await resequenceAndCommit(activeSet.id!, remaining);

      showToast({ type: "success", msg: "Removed and resequenced." });
      await refreshActiveSet(activeSet.id!);
    } catch (e) {
      console.error(e);
      showToast({ type: "error", msg: "Remove failed (permissions or network)." });
    }
  };

  const moveDoc = async (docId: string, direction: "up" | "down") => {
    if (!activeSet) return;
    if (!isController) {
      showToast({ type: "error", msg: "Read-only: Admin/DocCtrl only." });
      return;
    }

    const idx = setDocs.findIndex((d) => d.id === docId);
    if (idx < 0) return;

    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= setDocs.length) return;

    const a = setDocs[idx];
    const b = setDocs[swapIdx];

    const aNum = Number(a.sheetNumber) || idx + 1;
    const bNum = Number(b.sheetNumber) || swapIdx + 1;

    try {
      await Promise.all([
        supabase.from("documents").update({ sheet_number: bNum }).eq("id", a.id!),
        supabase.from("documents").update({ sheet_number: aNum }).eq("id", b.id!),
      ]);

      // Update local immediately for snappy UX, then re-pull authoritative
      const next = [...setDocs];
      next[idx] = { ...a, sheetNumber: bNum };
      next[swapIdx] = { ...b, sheetNumber: aNum };
      next.sort((x, y) => (Number(x.sheetNumber) || 0) - (Number(y.sheetNumber) || 0));
      setSetDocs(next);

      showToast({ type: "success", msg: "Order updated." });
    } catch (e) {
      console.error(e);
      showToast({ type: "error", msg: "Failed to reorder." });
    }
  };

  const deleteBinder = async () => {
    if (!activeSet) return;
    if (!isController) {
      showToast({ type: "error", msg: "Read-only: Admin/DocCtrl only." });
      return;
    }

    const ok = await appConfirm({
      title: `Delete binder "${activeSet.title}"?`,
      message: "This will remove set links from all its documents.",
      tone: "danger",
    });
    if (!ok) return;

    try {
      const { data: docsToUnassign } = await supabase.from("documents").select("id").eq("set_id", activeSet.id!);
      if (docsToUnassign && docsToUnassign.length > 0) {
        await Promise.all(docsToUnassign.map(d =>
          supabase.from("documents").update({ set_id: null, sheet_number: null, sheet_total: null }).eq("id", d.id)
        ));
      }
      await supabase.from("document_sets").delete().eq("id", activeSet.id!);

      showToast({ type: "success", msg: "Binder deleted." });
      resetUI();
      await fetchSets();
    } catch (e) {
      console.error(e);
      showToast({ type: "error", msg: "Delete failed." });
    }
  };

  // --- RENDER GUARDS ---
  if (!isOpen) return null;

  const readOnlyBanner = !roleLoading && !isController;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="w-full max-w-5xl bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden flex flex-col h-[82vh] animate-in fade-in zoom-in-95">
        {/* HEADER */}
        <div className="h-16 border-b border-[var(--color-border)] flex items-center justify-between px-6 bg-slate-50/50 shrink-0">
          <div className="flex items-center gap-3">
            <BookOpen className="w-5 h-5 text-[var(--color-accent)]" />
            <div>
              <h2 className="text-lg font-bold text-[var(--color-text)]">Binder Management</h2>
              <p className="text-xs text-[var(--color-text-muted)] font-medium">
                Document Sets / Packs (single source of truth for set membership)
              </p>
            </div>
          </div>
          <button onClick={() => { closeToast(); onClose(); }} aria-label="Close">
            <X className="w-5 h-5 text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)]" />
          </button>
        </div>

        {readOnlyBanner && (
          <div className="px-6 py-2 border-b border-[var(--color-border)] bg-amber-50 text-amber-900 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4" />
            <span className="font-semibold">Read-only:</span> only <span className="font-semibold">Admin</span> /
            <span className="font-semibold"> DocCtrl</span> can create binders or change membership.
          </div>
        )}

        <div className="flex flex-1 overflow-hidden">
          {/* LEFT SIDEBAR */}
          <div className="w-80 border-r border-[var(--color-border)] bg-[var(--color-surface-2)] flex flex-col">
            <div className="p-4 border-b border-[var(--color-border)] space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-xs font-bold uppercase text-[var(--color-text-muted)] tracking-wide">Binders</div>
                <div className="text-[11px] text-[var(--color-text-faint)] flex items-center gap-1">
                  <Settings className="w-3.5 h-3.5" />
                  <span>{activeRole || "…"}</span>
                </div>
              </div>

              <button
                onClick={() => {
                  if (!isController) return showToast({ type: "error", msg: "Read-only: Admin/DocCtrl only." });
                  setMode("create");
                  setActiveSet(null);
                  setSetDocs([]);
                  setNewSetTitle("");
                }}
                className={`w-full py-2 rounded-lg text-xs font-bold flex items-center justify-center gap-2 transition ${
                  isController ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]" : "bg-slate-200 text-[var(--color-text-muted)] cursor-not-allowed"
                }`}
                disabled={!isController}
              >
                <Plus className="w-3.5 h-3.5" />
                New Binder
              </button>

              {loading && (
                <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Loading binders…
                </div>
              )}
            </div>

            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {sets.map((set) => (
                <button
                  key={set.id}
                  onClick={() => void selectSet(set)}
                  className={`w-full text-left p-3 rounded-lg cursor-pointer border transition-all ${
                    activeSet?.id === set.id
                      ? "bg-[var(--color-surface)] border-[var(--color-accent)]/30 shadow-sm ring-1 ring-[var(--color-accent)]/20"
                      : "bg-transparent border-transparent hover:bg-[var(--color-surface-2)]"
                  }`}
                >
                  <div className="flex items-center justify-between mb-1 gap-2">
                    <span className="font-bold text-sm text-[var(--color-text)] truncate">{set.title}</span>
                    <span className="text-[10px] bg-slate-200 px-1.5 py-0.5 rounded text-[var(--color-text-muted)] shrink-0">
                      Rev {set.currentSetRev || "0"}
                    </span>
                  </div>
                  <div className="flex items-center text-xs text-[var(--color-text-faint)]">
                    <Layers className="w-3 h-3 mr-1" /> {set.sheetCount || 0} Sheets
                  </div>
                </button>
              ))}

              {!loading && sets.length === 0 && (
                <div className="p-4 text-xs text-[var(--color-text-muted)]">
                  No binders yet. {isController ? "Create one to start organizing controlled sheets." : "Ask DocCtrl/Admin to create one."}
                </div>
              )}
            </div>
          </div>

          {/* RIGHT PANEL */}
          <div className="flex-1 flex flex-col bg-[var(--color-surface)] relative">
            {/* CREATE MODE */}
            {mode === "create" && (
              <div className="flex flex-col items-center justify-center h-full p-10">
                <div className="w-full max-w-md">
                  <div className="flex items-center gap-2 mb-2 text-[var(--color-text)]">
                    <Folder className="w-5 h-5" />
                    <h3 className="text-lg font-bold">Create New Binder</h3>
                  </div>
                  <p className="text-xs text-[var(--color-text-muted)] mb-5">
                    A binder is a controlled “table of contents” for a pack (e.g., P&amp;ID set).
                  </p>

                  <label className="text-xs font-bold text-[var(--color-text-muted)] uppercase mb-1 block">Binder Title</label>
                  <input
                    value={newSetTitle}
                    onChange={(e) => setNewSetTitle(e.target.value)}
                    className="w-full p-3 border border-[var(--color-border)] rounded-lg mb-4 focus:ring-2 focus:ring-[var(--color-accent-ring)] outline-none"
                    placeholder="e.g. Unit 100 P&ID Master Set"
                    autoFocus
                    disabled={!isController}
                  />

                  <div className="flex gap-2">
                    <button
                      onClick={() => setMode("list")}
                      className="flex-1 py-3 border rounded-lg font-bold text-sm text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => void handleCreateSet()}
                      className={`flex-1 py-3 rounded-lg font-bold text-sm ${
                        isController ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]" : "bg-slate-200 text-[var(--color-text-muted)] cursor-not-allowed"
                      }`}
                      disabled={!isController}
                    >
                      Create
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* LIST MODE */}
            {mode === "list" && (
              <div className="h-full flex flex-col items-center justify-center text-[var(--color-text-faint)]">
                <BookOpen className="w-16 h-16 mb-4 opacity-20" />
                <p className="font-semibold">Select a Binder to View Contents</p>
                <p className="text-xs text-[var(--color-text-faint)] mt-1">Membership and ordering live here as the single source of truth.</p>
              </div>
            )}

            {/* EDIT MODE */}
            {mode === "edit" && activeSet && (
              <div className="flex flex-col h-full">
                {/* TOOLBAR */}
                <div className="border-b border-[var(--color-border)] px-6 py-4 shrink-0 flex items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    {!editingTitle ? (
                      <div className="flex items-center gap-2">
                        <h3 className="font-bold text-[var(--color-text)] truncate">{activeSet.title}</h3>
                        <span className="text-[11px] bg-slate-200 px-2 py-0.5 rounded text-[var(--color-text-muted)]">
                          Rev {activeSet.currentSetRev || "0"}
                        </span>
                        {isController && (
                          <button
                            onClick={() => { setEditingTitle(true); setTitleDraft(activeSet.title || ""); }}
                            className="text-xs font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-2 py-1 rounded hover:bg-[var(--color-surface-2)]"
                          >
                            Rename
                          </button>
                        )}
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <input
                          className="w-full max-w-lg p-2 border border-[var(--color-border)] rounded-lg outline-none focus:ring-2 focus:ring-[var(--color-accent-ring)] text-sm"
                          value={titleDraft}
                          onChange={(e) => setTitleDraft(e.target.value)}
                          autoFocus
                          disabled={!isController}
                        />
                        <button
                          onClick={() => void saveTitle()}
                          className={`px-3 py-2 rounded-lg text-xs font-bold ${
                            isController ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]" : "bg-slate-200 text-[var(--color-text-muted)] cursor-not-allowed"
                          }`}
                          disabled={!isController}
                        >
                          Save
                        </button>
                        <button
                          onClick={() => { setEditingTitle(false); setTitleDraft(activeSet.title || ""); }}
                          className="px-3 py-2 rounded-lg text-xs font-bold border text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"
                        >
                          Cancel
                        </button>
                      </div>
                    )}

                    <div className="text-xs text-[var(--color-text-muted)] mt-1 flex items-center gap-2">
                      <Layers className="w-4 h-4" />
                      <span className="font-semibold">{activeSet.sheetCount || setDocs.length}</span> sheets
                      <span className="text-slate-300">•</span>
                      <span className="truncate">Library: {libraryId}</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <div className="relative">
                      <div className="flex items-center border border-[var(--color-border)] rounded-lg px-3 py-2 bg-[var(--color-surface-2)] focus-within:bg-[var(--color-surface)] focus-within:ring-2 ring-[var(--color-accent-ring)] transition-all">
                        <Search className="w-4 h-4 text-[var(--color-text-faint)] mr-2" />
                        <input
                          className="bg-transparent outline-none text-sm w-72"
                          placeholder={isController ? "Search (doc #) to add…" : "Search (read-only)…"}
                          value={searchTerm}
                          onChange={(e) => void handleSearchDocs(e.target.value)}
                          disabled={!isController}
                        />
                        {searchLoading && <Loader2 className="w-4 h-4 animate-spin text-[var(--color-text-faint)] ml-2" />}
                      </div>

                      {searchResults.length > 0 && isController && (
                        <div className="absolute top-full right-0 w-[420px] bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg shadow-xl mt-2 p-1 z-50 animate-in fade-in zoom-in-95 duration-150">
                          {searchResults.map((res) => {
                            const alreadyHere = setDocs.some((d) => d.id === res.id);
                            const inOtherSet = !!res.setId && res.setId !== activeSet.id;
                            return (
                              <button
                                key={res.id}
                                onClick={() => void addToSet(res)}
                                className={`w-full p-2 rounded flex items-center justify-between gap-3 text-left ${
                                  alreadyHere || inOtherSet ? "opacity-60 cursor-not-allowed" : "hover:bg-[var(--color-accent-soft)]"
                                }`}
                                disabled={alreadyHere || inOtherSet}
                                title={
                                  inOtherSet
                                    ? "This document is already assigned to another binder."
                                    : alreadyHere
                                      ? "Already in this binder."
                                      : "Add to binder"
                                }
                              >
                                <div className="min-w-0">
                                  <div className="text-xs font-bold text-[var(--color-text)] truncate flex items-center gap-2">
                                    <FileText className="w-3.5 h-3.5 text-[var(--color-text-faint)]" />
                                    <span className="truncate">{res.documentNumber}</span>
                                    {inOtherSet && (
                                      <span className="text-[10px] px-2 py-0.5 rounded bg-amber-100 text-amber-900 border border-amber-200">
                                        In another binder
                                      </span>
                                    )}
                                    {alreadyHere && (
                                      <span className="text-[10px] px-2 py-0.5 rounded bg-[var(--color-surface-2)] text-[var(--color-text-muted)] border border-[var(--color-border)]">
                                        Already added
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-[11px] text-[var(--color-text-muted)] truncate">{res.title}</div>
                                </div>
                                <Plus className="w-4 h-4 text-[var(--color-text-faint)]" />
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    {isController && (
                      <button
                        onClick={() => void deleteBinder()}
                        className="px-3 py-2 rounded-lg text-xs font-bold text-red-600 border border-red-200 hover:bg-red-50 flex items-center gap-2"
                      >
                        <Trash2 className="w-4 h-4" />
                        Delete
                      </button>
                    )}
                  </div>
                </div>

                {/* CONTENT */}
                <div className="flex-1 overflow-y-auto p-6 bg-slate-50/30">
                  {docsLoading ? (
                    <div className="flex justify-center p-10">
                      <Loader2 className="w-8 h-8 animate-spin text-slate-300" />
                    </div>
                  ) : setDocs.length === 0 ? (
                    <div className="text-center p-10 border-2 border-dashed border-[var(--color-border)] rounded-xl bg-[var(--color-surface)]">
                      <Layers className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                      <p className="text-[var(--color-text)] font-bold">Binder is Empty</p>
                      <p className="text-[var(--color-text-muted)] text-xs mt-1">
                        {isController ? "Use search above to add documents." : "Ask DocCtrl/Admin to add documents."}
                      </p>
                    </div>
                  ) : (
                    <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl overflow-hidden">
                      <table className="w-full text-left">
                        <thead className="text-xs font-bold text-[var(--color-text-faint)] uppercase border-b border-[var(--color-border)] bg-[var(--color-surface-2)]">
                          <tr>
                            <th className="px-4 py-3 w-16">Seq</th>
                            <th className="px-4 py-3">Document</th>
                            <th className="px-4 py-3 w-24">Rev</th>
                            <th className="px-4 py-3 w-28">Status</th>
                            <th className="px-4 py-3 w-40 text-right">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[var(--color-border)]">
                          {setDocs.map((d, idx) => {
                            const locked = d.status === "Locked";
                            return (
                              <tr key={d.id} className="hover:bg-[var(--color-surface-2)] transition-colors">
                                <td className="px-4 py-3">
                                  <div className="w-9 h-9 rounded-lg bg-[var(--color-surface-2)] flex items-center justify-center font-mono font-bold text-[var(--color-text)] text-xs border border-[var(--color-border)]">
                                    {idx + 1}
                                  </div>
                                </td>
                                <td className="px-4 py-3">
                                  <div className="flex flex-col">
                                    <span className="text-sm font-bold text-[var(--color-text)]">{d.documentNumber}</span>
                                    <span className="text-xs text-[var(--color-text-muted)]">{d.title}</span>
                                  </div>
                                </td>
                                <td className="px-4 py-3">
                                  <span className="bg-blue-50 text-blue-700 px-2 py-1 rounded text-xs font-bold border border-blue-100">
                                    {d.rev || "—"}
                                  </span>
                                </td>
                                <td className="px-4 py-3">
                                  {locked ? (
                                    <span className="text-red-600 text-xs font-bold flex items-center">
                                      <AlertCircle className="w-3.5 h-3.5 mr-1" /> Locked
                                    </span>
                                  ) : (
                                    <span className="text-green-700 text-xs font-bold flex items-center">
                                      <CheckCircle2 className="w-3.5 h-3.5 mr-1" /> Active
                                    </span>
                                  )}
                                </td>
                                <td className="px-4 py-3">
                                  <div className="flex items-center justify-end gap-2">
                                    <button
                                      onClick={() => void moveDoc(d.id!, "up")}
                                      className={`p-2 rounded-lg border transition ${
                                        isController ? "hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]" : "text-slate-300 cursor-not-allowed"
                                      }`}
                                      disabled={!isController || idx === 0}
                                      title="Move up"
                                    >
                                      <ArrowUp className="w-4 h-4" />
                                    </button>
                                    <button
                                      onClick={() => void moveDoc(d.id!, "down")}
                                      className={`p-2 rounded-lg border transition ${
                                        isController ? "hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]" : "text-slate-300 cursor-not-allowed"
                                      }`}
                                      disabled={!isController || idx === setDocs.length - 1}
                                      title="Move down"
                                    >
                                      <ArrowDown className="w-4 h-4" />
                                    </button>
                                    <button
                                      onClick={() => void removeFromSet(d)}
                                      className={`p-2 rounded-lg border transition ${
                                        isController ? "hover:bg-red-50 text-[var(--color-text-muted)] hover:text-red-600" : "text-slate-300 cursor-not-allowed"
                                      }`}
                                      disabled={!isController}
                                      title="Remove"
                                    >
                                      <Trash2 className="w-4 h-4" />
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* TOAST */}
            {toast && (
              <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-50">
                <div
                  className={`px-4 py-3 rounded-xl shadow-xl border text-sm flex items-center gap-2 ${
                    toast.type === "success"
                      ? "bg-emerald-50 border-emerald-200 text-emerald-900"
                      : toast.type === "error"
                        ? "bg-red-50 border-red-200 text-red-900"
                        : "bg-[var(--color-surface-2)] border-[var(--color-border)] text-[var(--color-text)]"
                  }`}
                >
                  {toast.type === "success" ? (
                    <CheckCircle2 className="w-4 h-4" />
                  ) : toast.type === "error" ? (
                    <AlertCircle className="w-4 h-4" />
                  ) : (
                    <Settings className="w-4 h-4" />
                  )}
                  <span className="font-semibold">{toast.msg}</span>
                  <button onClick={closeToast} className="ml-2 text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)]">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
