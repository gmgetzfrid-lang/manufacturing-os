"use client";

// FolderDeleteModal — deleting a folder says exactly what happens to what's
// inside before anything happens.
//
// The old confirm only offered one behavior (the folder goes, its contents
// step up a level) and named it in a paragraph people didn't read — so
// "Delete" visibly left everything behind. This window counts the whole
// branch first and offers the two real choices side by side:
//   • the folder and everything in it (documents permanently deleted), or
//   • only the folder, its contents moving up a level.
// Several selected folders are handled in one go.

import React, { useEffect, useState } from "react";
import { AlertTriangle, FolderX, FolderOutput, Loader2, Trash2, X } from "lucide-react";
import { previewFolderDelete, deleteFolder, type FolderDeletePreview } from "@/lib/libraryCollections";

export interface FolderDeleteResult {
  mode: "all" | "lift";
  /** Every folder id that is gone (whole branches in "all" mode). */
  removedFolderIds: string[];
  /** The folders the user asked to delete. */
  rootIds: string[];
}

export default function FolderDeleteModal({
  orgId, folders, onClose, onDone,
}: {
  orgId: string;
  folders: Array<{ id: string; name: string }>;
  onClose: () => void;
  onDone: (r: FolderDeleteResult) => void;
}) {
  const [previews, setPreviews] = useState<FolderDeletePreview[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<"all" | "lift">("all");
  const [typed, setTyped] = useState("");
  const [running, setRunning] = useState<{ docs: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all(folders.map((f) => previewFolderDelete(f.id, orgId))).then(
      (p) => { if (live) setPreviews(p); },
      (e) => { if (live) setLoadError((e as Error).message); },
    );
    return () => { live = false; };
  }, [folders, orgId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !running) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, running]);

  const sum = (k: keyof FolderDeletePreview) =>
    (previews ?? []).reduce((n, p) => n + (typeof p[k] === "number" ? (p[k] as number) : 0), 0);
  const docs = sum("documents");
  const subfolders = sum("subfolders");
  const held = sum("held");
  const directDocs = sum("directDocuments");
  const directSubs = sum("directSubfolders");
  const empty = previews !== null && docs === 0 && subfolders === 0;
  const one = folders.length === 1;
  const title = one ? `Delete "${folders[0].name}"?` : `Delete ${folders.length} folders?`;
  const parentName = one ? (previews?.[0]?.parentName ?? "the library's top level") : "the folder above each one";
  const needsTyping = mode === "all" && docs >= 10;
  const canGo = previews !== null && !running && !(mode === "all" && held > 0) && (!needsTyping || typed.trim().toUpperCase() === "DELETE");

  const go = async () => {
    setError(null);
    setRunning({ docs: 0 });
    const removed: string[] = [];
    let base = 0;
    try {
      for (const f of folders) {
        let last = 0;
        try {
          const r = await deleteFolder(f.id, orgId, mode, (n) => { last = n; setRunning({ docs: base + n }); });
          removed.push(...r.deletedFolders);
        } catch (e) {
          // A folder nested under one deleted a moment ago is already gone.
          if (!/not found/i.test((e as Error).message)) throw e;
          removed.push(f.id);
        }
        base += last;
      }
      onDone({ mode, removedFolderIds: removed, rootIds: folders.map((f) => f.id) });
    } catch (e) {
      setError((e as Error).message);
      setRunning(null);
      if (removed.length) onDone({ mode, removedFolderIds: removed, rootIds: folders.map((f) => f.id) });
    }
  };

  const option = (value: "all" | "lift", Icon: typeof FolderX, t: string, children: React.ReactNode, disabled?: boolean) => (
    <label className={`flex items-start gap-3 rounded-xl border-2 p-3 cursor-pointer transition-colors ${
      mode === value
        ? value === "all" ? "border-rose-500 bg-rose-50/70 dark:bg-rose-950/20" : "border-blue-500 bg-blue-50/70 dark:bg-blue-950/20"
        : "border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"
    } ${disabled ? "opacity-60 cursor-not-allowed" : ""}`}>
      <input type="radio" name="folder-delete-mode" className="mt-1" checked={mode === value} disabled={disabled || !!running}
        onChange={() => setMode(value)} />
      <Icon className={`w-5 h-5 shrink-0 mt-0.5 ${value === "all" ? "text-rose-600" : "text-blue-600"}`} />
      <span className="min-w-0">
        <span className="block text-sm font-black text-[var(--color-text)]">{t}</span>
        <span className="block text-xs text-[var(--color-text-muted)] mt-0.5">{children}</span>
      </span>
    </label>
  );

  return (
    <div className="fixed inset-0 z-[300] bg-slate-900/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !running) onClose(); }}>
      <div className="w-full max-w-lg bg-[var(--color-surface)] rounded-t-2xl sm:rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden">
        <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-start gap-3">
          <div className="p-2 rounded-lg bg-rose-100 dark:bg-rose-950/40"><Trash2 className="w-5 h-5 text-rose-700 dark:text-rose-400" /></div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-black text-[var(--color-text)] truncate">{title}</div>
            <div className="text-xs text-[var(--color-text-muted)] mt-0.5">
              {loadError ? <span className="text-rose-600">{loadError}</span>
                : previews === null ? <span className="inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Counting what&apos;s inside…</span>
                : empty ? (one ? "This folder is empty." : "These folders are empty.")
                : <>Contains <b className="text-[var(--color-text)]">{docs.toLocaleString()} document{docs === 1 ? "" : "s"}</b>
                    {subfolders > 0 && <> in <b className="text-[var(--color-text)]">{subfolders.toLocaleString()} subfolder{subfolders === 1 ? "" : "s"}</b></>}.</>}
            </div>
          </div>
          <button onClick={onClose} disabled={!!running} className="p-1.5 rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-faint)] disabled:opacity-40">
            <X className="w-4 h-4" />
          </button>
        </div>

        {previews !== null && !empty && (
          <div className="p-5 space-y-2.5">
            {option("all", FolderX, "Delete the folder and everything in it", held > 0
                ? <span className="text-rose-700 dark:text-rose-400 font-bold">{held} document{held === 1 ? " is" : "s are"} under a legal hold inside — release the hold or move those records out first.</span>
                : <>All {docs.toLocaleString()} document{docs === 1 ? "" : "s"} are <b>permanently deleted</b>
                    {subfolders > 0 ? `, and all ${subfolders.toLocaleString()} subfolder${subfolders === 1 ? "" : "s"} go with ${one ? "it" : "them"}` : ""}.
                    {" "}The empty folder structure can be restored from Recently deleted for 30 days; the documents can&apos;t.</>,
              held > 0)}
            {option("lift", FolderOutput, "Delete only the folder — keep what's inside", directDocs > 0 || directSubs > 0
                ? <>Its {directDocs > 0 ? `${directDocs.toLocaleString()} document${directDocs === 1 ? "" : "s"}` : ""}
                    {directDocs > 0 && directSubs > 0 ? " and " : ""}
                    {directSubs > 0 ? `${directSubs} subfolder${directSubs === 1 ? "" : "s"}` : ""} move up into <b>{parentName}</b>. Nothing is deleted except the folder.</>
                : <>Nothing directly inside to move.</>)}
            {needsTyping && held === 0 && (
              <div className="pt-1">
                <label className="block text-[11px] font-bold text-[var(--color-text-muted)] mb-1">
                  Type <span className="font-black text-rose-700 dark:text-rose-400">DELETE</span> to permanently delete {docs.toLocaleString()} documents
                </label>
                <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus disabled={!!running}
                  className="w-full h-9 px-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-sm focus:outline-none focus:border-rose-400" />
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="mx-5 mb-3 rounded-lg border border-rose-300 bg-rose-50 dark:bg-rose-950/30 px-3 py-2 text-xs text-rose-700 dark:text-rose-300 flex gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
          </div>
        )}

        <div className="px-5 py-3 bg-[var(--color-surface-2)] border-t border-[var(--color-border)] flex items-center justify-between gap-2">
          <div className="text-[11px] text-[var(--color-text-muted)] min-w-0">
            {running && mode === "all" && docs > 0 && (
              <span className="inline-flex items-center gap-1.5 font-bold text-[var(--color-text)]">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> {running.docs.toLocaleString()} of {docs.toLocaleString()} documents deleted…
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onClose} disabled={!!running}
              className="px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border)] hover:bg-[var(--color-surface-2)] disabled:opacity-40">
              Cancel
            </button>
            <button onClick={() => void go()} disabled={!canGo}
              className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-black text-white disabled:opacity-40 ${
                mode === "all" || empty ? "bg-rose-600 hover:bg-rose-700" : "bg-blue-600 hover:bg-blue-700"}`}>
              {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
              {running ? "Deleting…"
                : empty ? (one ? "Delete folder" : `Delete ${folders.length} folders`)
                : mode === "all" ? `Delete everything (${docs.toLocaleString()} docs)`
                : one ? "Delete folder, keep contents" : "Delete folders, keep contents"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
