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
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  startAt,
  endAt,
  updateDoc,
  where,
  writeBatch,
  DocumentData,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { DocumentRecord, DocumentSet, Role } from "@/types/schema";
import { useRole } from "@/components/providers/RoleContext";

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

  const fetchSets = async () => {
    setLoading(true);
    try {
      const q = query(collection(db, "documentSets"), where("libraryId", "==", libraryId));
      const snap = await getDocs(q);
      const next = snap.docs
        .map((d) => ({ id: d.id, ...d.data() } as DocumentSet))
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
      // Prefer an ordered query (requires index if you add orderBy)
      // Fall back to local sorting if Firestore complains.
      let docs: DocumentRecord[] = [];
      try {
        const q = query(
          collection(db, "documents"),
          where("setId", "==", set.id),
          orderBy("sheetNumber", "asc")
        );
        const snap = await getDocs(q);
        docs = snap.docs.map((d) => ({ id: d.id, ...d.data() } as DocumentRecord));
      } catch (err) {
        console.warn("Ordered query failed (index?), falling back to unordered:", err);
        const q = query(collection(db, "documents"), where("setId", "==", set.id));
        const snap = await getDocs(q);
        docs = snap.docs.map((d) => ({ id: d.id, ...d.data() } as DocumentRecord));
      }

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
      await addDoc(collection(db, "documentSets"), {
        title,
        libraryId,
        currentSetRev: "0",
        sheetCount: 0,
        assetIndex: {},
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
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
      await updateDoc(doc(db, "documentSets", activeSet.id!), {
        title: nextTitle,
        updatedAt: serverTimestamp(),
      });
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
      // IMPORTANT: range queries require orderBy on the same field
      const q = query(
        collection(db, "documents"),
        where("libraryId", "==", libraryId),
        orderBy("documentNumber"),
        startAt(t),
        endAt(t + "\uf8ff"),
        limit(12)
      );
      const snap = await getDocs(q);
      const results = snap.docs.map((d) => ({ id: d.id, ...d.data() } as DocumentRecord));

      // Sort: exact startsWith first, then alpha
      results.sort((a, b) => {
        const an = (a.documentNumber || "").toUpperCase();
        const bn = (b.documentNumber || "").toUpperCase();
        const aStarts = an.startsWith(t) ? 0 : 1;
        const bStarts = bn.startsWith(t) ? 0 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;
        return an.localeCompare(bn);
      });

      setSearchResults(results);
    } catch (e) {
      console.error(e);
      showToast({
        type: "error",
        msg: "Search failed (index or permissions).",
      });
    } finally {
      setSearchLoading(false);
    }
  };

  // --- MEMBERSHIP MUTATIONS ---
  const refreshActiveSet = async (setId: string) => {
    const s = await getDoc(doc(db, "documentSets", setId));
    if (!s.exists()) return;
    const next = { id: s.id, ...s.data() } as DocumentSet;
    setActiveSet(next);
    setSets((prev) => prev.map((x) => (x.id === next.id ? next : x)));
    await loadSetDocs(next);
  };

  const bestEffortUpdateSheetTotals = async (setId: string, total: number) => {
    // This keeps sheetTotal consistent for binder exports/UI.
    // Best-effort to avoid turning every add/remove into an expensive operation on huge sets.
    try {
      const q = query(collection(db, "documents"), where("setId", "==", setId));
      const snap = await getDocs(q);
      const docs = snap.docs;
      if (docs.length > 200) return; // avoid heavy updates
      const batch = writeBatch(db);
      docs.forEach((d) => {
        batch.update(d.ref, { sheetTotal: total });
      });
      await batch.commit();
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
      // Transaction: ensure sheetCount consistency even with concurrent updates
      await runTransaction(db, async (tx) => {
        const setRef = doc(db, "documentSets", activeSet.id!);
        const docRef = doc(db, "documents", docRecord.id!);

        const setSnap = await tx.get(setRef);
        const docSnap = await tx.get(docRef);

        if (!setSnap.exists()) throw new Error("Set not found.");
        if (!docSnap.exists()) throw new Error("Document not found.");

        const setData = setSnap.data() as DocumentData;
        const docData = docSnap.data() as DocumentData;

        const currentCount = Number(setData.sheetCount) || 0;
        const nextSeq = currentCount + 1;

        const existingSetId = docData.setId ?? null;
        if (existingSetId && existingSetId !== activeSet.id) {
          // You can choose to support "move" later; for now: explicit stop.
          throw new Error("This document is already assigned to a different binder.");
        }

        tx.update(docRef, {
          setId: activeSet.id,
          sheetNumber: nextSeq,
          sheetTotal: nextSeq,
        });

        tx.update(setRef, {
          sheetCount: nextSeq,
          updatedAt: serverTimestamp(),
        });
      });

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
    const chunkSize = 450; // keep margin under 500 writes
    for (let i = 0; i < updates.length; i += chunkSize) {
      const batch = writeBatch(db);
      updates.slice(i, i + chunkSize).forEach((u) => {
        batch.update(doc(db, "documents", u.id), {
          sheetNumber: u.sheetNumber,
          sheetTotal: u.sheetTotal,
        });
      });
      await batch.commit();
    }

    // 2) Update set sheetCount
    await updateDoc(doc(db, "documentSets", setId), {
      sheetCount: total,
      updatedAt: serverTimestamp(),
    });
  };

  const removeFromSet = async (docRecord: DocumentRecord) => {
    if (!activeSet) return;
    if (!isController) {
      showToast({ type: "error", msg: "Read-only: Admin/DocCtrl only." });
      return;
    }

    const ok = window.confirm(`Remove ${docRecord.documentNumber || "this document"} from binder?`);
    if (!ok) return;

    try {
      // Remove fields from this document first
      await updateDoc(doc(db, "documents", docRecord.id!), {
        setId: null,
        sheetNumber: null,
        sheetTotal: null,
      });

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
      const batch = writeBatch(db);
      batch.update(doc(db, "documents", a.id!), { sheetNumber: bNum });
      batch.update(doc(db, "documents", b.id!), { sheetNumber: aNum });
      await batch.commit();

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

    const ok = window.confirm(
      `Delete binder "${activeSet.title}"?\n\nThis will remove set links from all its documents.`
    );
    if (!ok) return;

    try {
      // Unassign docs first (batch)
      const q = query(collection(db, "documents"), where("setId", "==", activeSet.id!));
      const snap = await getDocs(q);

      const docs = snap.docs;
      const chunkSize = 450;

      for (let i = 0; i < docs.length; i += chunkSize) {
        const batch = writeBatch(db);
        docs.slice(i, i + chunkSize).forEach((d) => {
          batch.update(d.ref, {
            setId: null,
            sheetNumber: null,
            sheetTotal: null,
          });
        });
        await batch.commit();
      }

      await deleteDoc(doc(db, "documentSets", activeSet.id!));

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
      <div className="w-full max-w-5xl bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col h-[82vh]">
        {/* HEADER */}
        <div className="h-16 border-b border-slate-200 flex items-center justify-between px-6 bg-slate-50/50 shrink-0">
          <div className="flex items-center gap-3">
            <BookOpen className="w-5 h-5 text-blue-600" />
            <div>
              <h2 className="text-lg font-bold text-slate-900">Binder Management</h2>
              <p className="text-xs text-slate-500 font-medium">
                Document Sets / Packs (single source of truth for set membership)
              </p>
            </div>
          </div>
          <button onClick={() => { closeToast(); onClose(); }} aria-label="Close">
            <X className="w-5 h-5 text-slate-400 hover:text-slate-600" />
          </button>
        </div>

        {readOnlyBanner && (
          <div className="px-6 py-2 border-b border-slate-200 bg-amber-50 text-amber-900 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4" />
            <span className="font-semibold">Read-only:</span> only <span className="font-semibold">Admin</span> /
            <span className="font-semibold"> DocCtrl</span> can create binders or change membership.
          </div>
        )}

        <div className="flex flex-1 overflow-hidden">
          {/* LEFT SIDEBAR */}
          <div className="w-80 border-r border-slate-200 bg-slate-50 flex flex-col">
            <div className="p-4 border-b border-slate-200 space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-xs font-bold uppercase text-slate-500 tracking-wide">Binders</div>
                <div className="text-[11px] text-slate-400 flex items-center gap-1">
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
                  isController ? "bg-blue-600 text-white hover:bg-blue-700" : "bg-slate-200 text-slate-500 cursor-not-allowed"
                }`}
                disabled={!isController}
              >
                <Plus className="w-3.5 h-3.5" />
                New Binder
              </button>

              {loading && (
                <div className="flex items-center gap-2 text-xs text-slate-500">
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
                      ? "bg-white border-blue-200 shadow-sm ring-1 ring-blue-100"
                      : "bg-transparent border-transparent hover:bg-slate-100"
                  }`}
                >
                  <div className="flex items-center justify-between mb-1 gap-2">
                    <span className="font-bold text-sm text-slate-700 truncate">{set.title}</span>
                    <span className="text-[10px] bg-slate-200 px-1.5 py-0.5 rounded text-slate-600 shrink-0">
                      Rev {set.currentSetRev || "0"}
                    </span>
                  </div>
                  <div className="flex items-center text-xs text-slate-400">
                    <Layers className="w-3 h-3 mr-1" /> {set.sheetCount || 0} Sheets
                  </div>
                </button>
              ))}

              {!loading && sets.length === 0 && (
                <div className="p-4 text-xs text-slate-500">
                  No binders yet. {isController ? "Create one to start organizing controlled sheets." : "Ask DocCtrl/Admin to create one."}
                </div>
              )}
            </div>
          </div>

          {/* RIGHT PANEL */}
          <div className="flex-1 flex flex-col bg-white relative">
            {/* CREATE MODE */}
            {mode === "create" && (
              <div className="flex flex-col items-center justify-center h-full p-10">
                <div className="w-full max-w-md">
                  <div className="flex items-center gap-2 mb-2 text-slate-700">
                    <Folder className="w-5 h-5" />
                    <h3 className="text-lg font-bold">Create New Binder</h3>
                  </div>
                  <p className="text-xs text-slate-500 mb-5">
                    A binder is a controlled “table of contents” for a pack (e.g., P&amp;ID set).
                  </p>

                  <label className="text-xs font-bold text-slate-500 uppercase mb-1 block">Binder Title</label>
                  <input
                    value={newSetTitle}
                    onChange={(e) => setNewSetTitle(e.target.value)}
                    className="w-full p-3 border border-slate-200 rounded-lg mb-4 focus:ring-2 focus:ring-blue-500 outline-none"
                    placeholder="e.g. Unit 100 P&ID Master Set"
                    autoFocus
                    disabled={!isController}
                  />

                  <div className="flex gap-2">
                    <button
                      onClick={() => setMode("list")}
                      className="flex-1 py-3 border rounded-lg font-bold text-sm text-slate-600 hover:bg-slate-50"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => void handleCreateSet()}
                      className={`flex-1 py-3 rounded-lg font-bold text-sm ${
                        isController ? "bg-blue-600 text-white hover:bg-blue-700" : "bg-slate-200 text-slate-500 cursor-not-allowed"
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
              <div className="h-full flex flex-col items-center justify-center text-slate-400">
                <BookOpen className="w-16 h-16 mb-4 opacity-20" />
                <p className="font-semibold">Select a Binder to View Contents</p>
                <p className="text-xs text-slate-400 mt-1">Membership and ordering live here as the single source of truth.</p>
              </div>
            )}

            {/* EDIT MODE */}
            {mode === "edit" && activeSet && (
              <div className="flex flex-col h-full">
                {/* TOOLBAR */}
                <div className="border-b border-slate-100 px-6 py-4 shrink-0 flex items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    {!editingTitle ? (
                      <div className="flex items-center gap-2">
                        <h3 className="font-bold text-slate-900 truncate">{activeSet.title}</h3>
                        <span className="text-[11px] bg-slate-200 px-2 py-0.5 rounded text-slate-600">
                          Rev {activeSet.currentSetRev || "0"}
                        </span>
                        {isController && (
                          <button
                            onClick={() => { setEditingTitle(true); setTitleDraft(activeSet.title || ""); }}
                            className="text-xs font-bold text-slate-500 hover:text-slate-700 px-2 py-1 rounded hover:bg-slate-100"
                          >
                            Rename
                          </button>
                        )}
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <input
                          className="w-full max-w-lg p-2 border border-slate-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-200 text-sm"
                          value={titleDraft}
                          onChange={(e) => setTitleDraft(e.target.value)}
                          autoFocus
                          disabled={!isController}
                        />
                        <button
                          onClick={() => void saveTitle()}
                          className={`px-3 py-2 rounded-lg text-xs font-bold ${
                            isController ? "bg-blue-600 text-white hover:bg-blue-700" : "bg-slate-200 text-slate-500 cursor-not-allowed"
                          }`}
                          disabled={!isController}
                        >
                          Save
                        </button>
                        <button
                          onClick={() => { setEditingTitle(false); setTitleDraft(activeSet.title || ""); }}
                          className="px-3 py-2 rounded-lg text-xs font-bold border text-slate-600 hover:bg-slate-50"
                        >
                          Cancel
                        </button>
                      </div>
                    )}

                    <div className="text-xs text-slate-500 mt-1 flex items-center gap-2">
                      <Layers className="w-4 h-4" />
                      <span className="font-semibold">{activeSet.sheetCount || setDocs.length}</span> sheets
                      <span className="text-slate-300">•</span>
                      <span className="truncate">Library: {libraryId}</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <div className="relative">
                      <div className="flex items-center border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 focus-within:bg-white focus-within:ring-2 ring-blue-100 transition-all">
                        <Search className="w-4 h-4 text-slate-400 mr-2" />
                        <input
                          className="bg-transparent outline-none text-sm w-72"
                          placeholder={isController ? "Search (doc #) to add…" : "Search (read-only)…"}
                          value={searchTerm}
                          onChange={(e) => void handleSearchDocs(e.target.value)}
                          disabled={!isController}
                        />
                        {searchLoading && <Loader2 className="w-4 h-4 animate-spin text-slate-400 ml-2" />}
                      </div>

                      {searchResults.length > 0 && isController && (
                        <div className="absolute top-full right-0 w-[420px] bg-white border border-slate-200 rounded-lg shadow-xl mt-2 p-1 z-50">
                          {searchResults.map((res) => {
                            const alreadyHere = setDocs.some((d) => d.id === res.id);
                            const inOtherSet = !!res.setId && res.setId !== activeSet.id;
                            return (
                              <button
                                key={res.id}
                                onClick={() => void addToSet(res)}
                                className={`w-full p-2 rounded flex items-center justify-between gap-3 text-left ${
                                  alreadyHere || inOtherSet ? "opacity-60 cursor-not-allowed" : "hover:bg-blue-50"
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
                                  <div className="text-xs font-bold text-slate-800 truncate flex items-center gap-2">
                                    <FileText className="w-3.5 h-3.5 text-slate-400" />
                                    <span className="truncate">{res.documentNumber}</span>
                                    {inOtherSet && (
                                      <span className="text-[10px] px-2 py-0.5 rounded bg-amber-100 text-amber-900 border border-amber-200">
                                        In another binder
                                      </span>
                                    )}
                                    {alreadyHere && (
                                      <span className="text-[10px] px-2 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200">
                                        Already added
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-[11px] text-slate-500 truncate">{res.title}</div>
                                </div>
                                <Plus className="w-4 h-4 text-slate-400" />
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
                    <div className="text-center p-10 border-2 border-dashed border-slate-200 rounded-xl bg-white">
                      <Layers className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                      <p className="text-slate-700 font-bold">Binder is Empty</p>
                      <p className="text-slate-500 text-xs mt-1">
                        {isController ? "Use search above to add documents." : "Ask DocCtrl/Admin to add documents."}
                      </p>
                    </div>
                  ) : (
                    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                      <table className="w-full text-left">
                        <thead className="text-xs font-bold text-slate-400 uppercase border-b border-slate-200 bg-slate-50">
                          <tr>
                            <th className="px-4 py-3 w-16">Seq</th>
                            <th className="px-4 py-3">Document</th>
                            <th className="px-4 py-3 w-24">Rev</th>
                            <th className="px-4 py-3 w-28">Status</th>
                            <th className="px-4 py-3 w-40 text-right">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {setDocs.map((d, idx) => {
                            const locked = d.status === "Locked";
                            return (
                              <tr key={d.id} className="hover:bg-slate-50 transition-colors">
                                <td className="px-4 py-3">
                                  <div className="w-9 h-9 rounded-lg bg-slate-100 flex items-center justify-center font-mono font-bold text-slate-700 text-xs border border-slate-200">
                                    {idx + 1}
                                  </div>
                                </td>
                                <td className="px-4 py-3">
                                  <div className="flex flex-col">
                                    <span className="text-sm font-bold text-slate-900">{d.documentNumber}</span>
                                    <span className="text-xs text-slate-600">{d.title}</span>
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
                                        isController ? "hover:bg-slate-50 text-slate-600" : "text-slate-300 cursor-not-allowed"
                                      }`}
                                      disabled={!isController || idx === 0}
                                      title="Move up"
                                    >
                                      <ArrowUp className="w-4 h-4" />
                                    </button>
                                    <button
                                      onClick={() => void moveDoc(d.id!, "down")}
                                      className={`p-2 rounded-lg border transition ${
                                        isController ? "hover:bg-slate-50 text-slate-600" : "text-slate-300 cursor-not-allowed"
                                      }`}
                                      disabled={!isController || idx === setDocs.length - 1}
                                      title="Move down"
                                    >
                                      <ArrowDown className="w-4 h-4" />
                                    </button>
                                    <button
                                      onClick={() => void removeFromSet(d)}
                                      className={`p-2 rounded-lg border transition ${
                                        isController ? "hover:bg-red-50 text-slate-600 hover:text-red-600" : "text-slate-300 cursor-not-allowed"
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
                        : "bg-slate-50 border-slate-200 text-slate-800"
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
                  <button onClick={closeToast} className="ml-2 text-slate-400 hover:text-slate-600">
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
