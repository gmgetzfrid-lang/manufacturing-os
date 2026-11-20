"use client";

// DocumentLinkPicker — choose a document to link to a tag, two ways:
//   • Browse existing — pick a document already in the system (library + search).
//   • Upload new      — drop a PDF, create the document in a library/folder, and
//                       link it. Folders and even libraries can be created inline
//                       (Save-As style) without leaving the picker.

import React, { useCallback, useEffect, useState } from "react";
import { Search, Loader2, FileText, Check, X, Upload, FolderPlus, Plus, Library as LibraryIcon } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { searchDocuments, type DocumentRow } from "@/lib/search";
import { createDocumentWithFile } from "@/lib/revisions";
import FileThumb from "@/components/ui/FileThumb";
import { useFileDrag } from "@/hooks/useFileDrag";
import { tryUpload } from "@/lib/uploadRetry";
import { createFolder, createLibrary, listLibraryFoldersOnce, type PickerFolder } from "@/lib/libraryCollections";
import { appPrompt, appAlert } from "@/components/providers/DialogProvider";
import { useEscapeClose } from "@/components/documents/useEscapeClose";

export default function DocumentLinkPicker({ orgId, userId, canManage = false, excludeIds = [], onPick, onClose }: {
  orgId: string;
  userId?: string;
  canManage?: boolean;
  excludeIds?: string[];
  onPick: (documentId: string) => void | Promise<void>;
  onClose: () => void;
}) {
  // Escape closes this dialog (only the top one when they stack).
  useEscapeClose(() => onClose());
  const [tab, setTab] = useState<"browse" | "upload">("browse");
  const [libraries, setLibraries] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data } = await supabase.from("libraries").select("id, name").eq("org_id", orgId).order("name");
      if (alive) setLibraries((data as { id: string; name: string }[]) ?? []);
    })();
    return () => { alive = false; };
  }, [orgId]);

  // ── Browse existing ──────────────────────────────────────────────────────
  const [libraryId, setLibraryId] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DocumentRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [linking, setLinking] = useState<string | null>(null);

  const runSearch = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await searchDocuments({ orgId, query: query.trim() || undefined, libraryId: libraryId || undefined, limit: 50 });
      setResults(rows);
    } catch { setResults([]); } finally { setLoading(false); }
  }, [orgId, query, libraryId]);
  useEffect(() => { const t = setTimeout(runSearch, 200); return () => clearTimeout(t); }, [runSearch]);
  const visible = results.filter((r) => !excludeIds.includes(r.id));

  // ── Upload new ───────────────────────────────────────────────────────────
  const [upLibraryId, setUpLibraryId] = useState("");
  const [folders, setFolders] = useState<PickerFolder[]>([]);
  const [folderId, setFolderId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const pdfDrag = useFileDrag((fs) => setFile(fs[0] ?? null));
  const [docNum, setDocNum] = useState("");
  const [docTitle, setDocTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [upError, setUpError] = useState<string | null>(null);

  useEffect(() => {
    if (!upLibraryId) { setFolders([]); setFolderId(""); return; }
    let alive = true;
    listLibraryFoldersOnce(upLibraryId).then((f) => { if (alive) setFolders(f); }).catch(() => { if (alive) setFolders([]); });
    return () => { alive = false; };
  }, [upLibraryId]);

  const addLibrary = async () => {
    if (!userId) return;
    const name = await appPrompt({ title: "New library", placeholder: "Library name" });
    if (!name?.trim()) return;
    try {
      const lib = await createLibrary({ orgId, name: name.trim(), createdBy: userId });
      setLibraries((p) => [...p, { id: lib.id, name: lib.name }].sort((a, b) => a.name.localeCompare(b.name)));
      setUpLibraryId(lib.id);
    } catch (e) { await appAlert({ message: (e as Error).message, tone: "danger" }); }
  };
  const addFolder = async () => {
    if (!userId || !upLibraryId) return;
    const name = await appPrompt({ title: "New folder", message: folderId ? "Created inside the selected folder." : "Created at the library root.", placeholder: "Folder name" });
    if (!name?.trim()) return;
    try {
      const id = await createFolder({ orgId, libraryId: upLibraryId, parentId: folderId || null, name: name.trim(), createdBy: userId });
      setFolders(await listLibraryFoldersOnce(upLibraryId));
      setFolderId(id);
    } catch (e) {
      // The DB enforces that folder creation is an Admin/DocCtrl act
      // (migration 20261011) — translate its refusal into the product rule.
      const msg = (e as Error).message;
      await appAlert({
        message: /row-level security|policy/i.test(msg)
          ? "Creating folders needs Admin or Document Control. Pick an existing folder, or ask Doc Control to add one."
          : msg,
        tone: "danger",
      });
    }
  };
  const createAndLink = async () => {
    if (!userId) return;
    if (!upLibraryId || !file || !docNum.trim()) { setUpError("Pick a library, attach a PDF, and enter a document number."); return; }
    setCreating(true); setUpError(null);
    try {
      const folder = folders.find((f) => f.id === folderId);
      // Upload + create, wrapped for "Try again" with the same file. A retry
      // can't make a second copy: the library refuses a number it already has.
      const { documentId } = await tryUpload(file.name, () => createDocumentWithFile({
        orgId, libraryId: upLibraryId, collectionId: folderId || null,
        folderPath: folder ? folder.pathNames : undefined,
        documentNumber: docNum.trim(), title: docTitle.trim() || undefined,
        file, actorUserId: userId,
      }), { onRetried: (r) => { void onPick(r.documentId); } });
      await onPick(documentId);
    } catch (e) { setUpError(`It didn't upload: ${(e as Error).message}`); } finally { setCreating(false); }
  };

  const fieldCls = "text-[13px] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] px-2.5 py-1.5 outline-none focus:border-[var(--color-border-strong)]";

  return (
    <div className="fixed inset-0 z-[520] flex items-center justify-center bg-[color-mix(in_srgb,var(--color-ink)_58%,transparent)] p-4" onClick={onClose}>
      <div className="w-full max-w-xl bg-[var(--color-surface)] rounded-lg shadow-2xl border border-[var(--color-border)] overflow-hidden flex flex-col max-h-[82vh]" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-[var(--color-border)] flex items-center gap-3">
          <FileText className="w-5 h-5 text-[var(--color-text-muted)]" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold text-[var(--color-text)]">Link a drawing</div>
            <div className="text-[13px] text-[var(--color-text-muted)]">Reference an existing document, or upload a new one</div>
          </div>
          <button aria-label="Close" onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]"><X className="w-4 h-4" /></button>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 px-3 pt-2 shrink-0">
          <button onClick={() => setTab("browse")} className={`flex-1 inline-flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-[11px] font-bold transition-colors ${tab === "browse" ? "bg-[var(--color-surface-2)] text-[var(--color-text)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}><Search className="w-3.5 h-3.5" /> Browse existing</button>
          <button onClick={() => setTab("upload")} className={`flex-1 inline-flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-[11px] font-bold transition-colors ${tab === "upload" ? "bg-[var(--color-surface-2)] text-[var(--color-text)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}><Upload className="w-3.5 h-3.5" /> Upload new</button>
        </div>

        {tab === "browse" ? (
          <>
            <div className="px-5 py-3 flex items-center gap-2">
              <select value={libraryId} onChange={(e) => setLibraryId(e.target.value)} className={`${fieldCls} shrink-0 max-w-[40%]`}>
                <option value="">All libraries</option>
                {libraries.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
              <div className="flex-1 flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-2.5 py-1.5">
                <Search className="w-4 h-4 text-[var(--color-text-faint)] shrink-0" />
                <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by number or title…" className="bg-transparent text-[13px] text-[var(--color-text)] outline-none w-full min-w-0" />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto border-t border-[var(--color-border)]">
              {loading ? (
                <div className="flex items-center justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-[var(--color-text-muted)]" /></div>
              ) : visible.length === 0 ? (
                <div className="text-center py-12 text-[13px] text-[var(--color-text-muted)]">No documents found.</div>
              ) : (
                visible.map((r) => (
                  <button key={r.id} disabled={!!linking} onClick={async () => { setLinking(r.id); try { await onPick(r.id); } finally { setLinking(null); } }} className="group w-full text-left px-5 py-2.5 border-b border-[var(--color-border)]/50 hover:bg-[var(--color-surface-2)] flex items-center gap-3 disabled:opacity-50">
                    <FileText className="w-4 h-4 text-[var(--color-text-faint)] shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-bold text-[var(--color-text)] truncate">{r.document_number || r.title || r.name || "Document"}</div>
                      <div className="text-[13px] text-[var(--color-text-muted)] truncate">{r.title || r.name || ""}{r.rev ? ` · Rev ${r.rev}` : ""}</div>
                    </div>
                    {linking === r.id ? <Loader2 className="w-4 h-4 animate-spin text-[var(--color-text-muted)] shrink-0" /> : <Check className="w-4 h-4 text-emerald-600 opacity-60 sm:opacity-0 group-hover:opacity-100 shrink-0" />}
                  </button>
                ))
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 overflow-y-auto p-5 space-y-3">
            <div className="space-y-1">
              <label className="text-[13px] font-semibold text-[var(--color-text-muted)]">Library</label>
              <div className="flex items-center gap-2">
                <select value={upLibraryId} onChange={(e) => { setUpLibraryId(e.target.value); setFolderId(""); }} className={`${fieldCls} flex-1`}>
                  <option value="">Choose a library…</option>
                  {libraries.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
                {canManage && <button onClick={addLibrary} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[var(--color-border)] text-[11px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"><LibraryIcon className="w-3.5 h-3.5" /> New</button>}
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-[13px] font-semibold text-[var(--color-text-muted)]">Folder</label>
              <div className="flex items-center gap-2">
                <select value={folderId} onChange={(e) => setFolderId(e.target.value)} disabled={!upLibraryId} className={`${fieldCls} flex-1 disabled:opacity-50`}>
                  <option value="">{upLibraryId ? "Library root" : "Pick a library first"}</option>
                  {folders.map((f) => <option key={f.id} value={f.id}>{f.pathNames.join(" / ") || f.name}</option>)}
                </select>
                {canManage && <button onClick={addFolder} disabled={!upLibraryId} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[var(--color-border)] text-[11px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50"><FolderPlus className="w-3.5 h-3.5" /> New</button>}
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-[13px] font-semibold text-[var(--color-text-muted)]">PDF</label>
              <label {...pdfDrag.bind} className={`flex items-center gap-3 rounded-lg border-2 border-dashed border-[var(--color-border-strong)] p-3 cursor-pointer hover:bg-[var(--color-surface-2)] ${pdfDrag.ring}`}>
                <input type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="sr-only" />
                {pdfDrag.over ? (
                  <span className="text-[13px] font-bold text-[var(--color-text)]">{pdfDrag.say}</span>
                ) : file ? (
                  <>
                    <FileThumb file={file} size={32} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-semibold text-[var(--color-text)] truncate">{file.name}</span>
                      <span className="block text-[13px] text-[var(--color-text-muted)]">{file.size < 1024 * 1024 ? `${(file.size / 1024).toFixed(0)} KB` : `${(file.size / (1024 * 1024)).toFixed(1)} MB`} · tap to pick another</span>
                    </span>
                  </>
                ) : (
                  <span className="text-xs text-[var(--color-text-muted)] inline-flex items-center gap-1.5"><Upload className="w-3.5 h-3.5" /> Drop the PDF here, or tap to pick it</span>
                )}
              </label>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="text-[13px] font-semibold text-[var(--color-text-muted)]">Document number *</label>
                <input value={docNum} onChange={(e) => setDocNum(e.target.value)} placeholder="e.g. ISO-C7-001" className={`${fieldCls} w-full`} />
              </div>
              <div className="space-y-1">
                <label className="text-[13px] font-semibold text-[var(--color-text-muted)]">Title</label>
                <input value={docTitle} onChange={(e) => setDocTitle(e.target.value)} placeholder="optional" className={`${fieldCls} w-full`} />
              </div>
            </div>

            {upError && <p role="alert" className="border-l-2 border-rose-500 pl-3 text-[13px] text-rose-700 dark:text-rose-300">{upError}</p>}

            <div className="flex justify-end pt-1">
              <button onClick={createAndLink} disabled={creating || !upLibraryId || !file || !docNum.trim()} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-accent-fg)] text-[13px] font-bold disabled:opacity-40 disabled:cursor-not-allowed">
                {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Create &amp; link
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
