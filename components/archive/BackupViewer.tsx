"use client";

// BackupViewer — open files straight out of an offline backup zip, in memory.
//
// The frictionless half of Machine A: drop the archive, find the file, view it,
// and when you close the page it's gone — nothing is ever re-uploaded or
// re-saved on our servers, so archiving for space stays archived.
//
// `target` (optional) drives the "you were sent here to view ONE specific file"
// flow: it shows the archived-file notice and, on drop, jumps straight to that
// file via findInBackup. With no target, it's a browse-the-whole-backup utility.

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  UploadCloud, Loader2, AlertTriangle, FileText, Image as ImageIcon,
  File as FileIcon, Search, X, Eye, Download, ShieldCheck,
} from "lucide-react";
import { archivedNotice, findInBackup } from "@/lib/archive";

type ZipLike = {
  files: Record<string, { dir: boolean }>;
  file(path: string): { async(type: "blob"): Promise<Blob> } | null;
};

export interface ArchiveTarget {
  storageKey: string;
  fileName?: string;
  archiveId?: string | null;
  /** The org's archive root folder; the notice composes <root>/data/<id>.zip. */
  root?: string | null;
  kind?: "full" | "space";
}

interface Entry { path: string; name: string }

function kindOf(name: string): "pdf" | "image" | "other" {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (ext === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext)) return "image";
  return "other";
}

export default function BackupViewer({ target }: { target?: ArchiveTarget }) {
  const [zip, setZip] = useState<ZipLike | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [dragging, setDragging] = useState(false);

  const [preview, setPreview] = useState<{ name: string; url: string; kind: ReturnType<typeof kindOf> } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const objectUrlRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Revoke any object URL we hold — on switch, clear, and unmount. This is the
  // "discard" guarantee: nothing lingers.
  const revoke = useCallback(() => {
    if (objectUrlRef.current) { URL.revokeObjectURL(objectUrlRef.current); objectUrlRef.current = null; }
  }, []);
  useEffect(() => () => revoke(), [revoke]);

  const openEntry = useCallback(async (z: ZipLike, path: string, name: string) => {
    setPreviewBusy(true); setError(null);
    try {
      const f = z.file(path);
      if (!f) throw new Error("File not found in archive");
      const blob = await f.async("blob");
      revoke();
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;
      setPreview({ name, url, kind: kindOf(name) });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPreviewBusy(false);
    }
  }, [revoke]);

  const handleFile = useCallback(async (file: File) => {
    if (!/\.zip$/i.test(file.name)) { setError("Drop the backup .zip (the “Full ZIP” download)."); return; }
    setLoading(true); setError(null); setPreview(null); revoke();
    try {
      const JSZip = (await import("jszip")).default;
      const z = await JSZip.loadAsync(file) as unknown as ZipLike;
      const all: Entry[] = Object.keys(z.files)
        .filter((p) => !z.files[p].dir && /^\/?files\//i.test(p))
        .map((p) => ({ path: p, name: p.split("/").pop() || p }))
        .sort((a, b) => a.path.localeCompare(b.path));
      setZip(z);
      setEntries(all);
      if (all.length === 0) setError("This backup has no /files folder — it may be a JSON-only export (no binaries).");

      // Targeted flow: jump straight to the one file the user came to view.
      if (target?.storageKey) {
        const hit = findInBackup(all.map((e) => e.path), target.storageKey);
        if (hit) await openEntry(z, hit, target.fileName || hit.split("/").pop() || hit);
        else setError(`This backup doesn't contain ${target.fileName || "that file"}${target.archiveId ? ` — is it archive ${target.archiveId}?` : "."}`);
      }
    } catch (e) {
      setError(`Couldn't read that archive: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [revoke, openEntry, target]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void handleFile(f);
  };

  const clearAll = () => { revoke(); setZip(null); setEntries([]); setPreview(null); setError(null); setFilter(""); };

  const shown = filter.trim()
    ? entries.filter((e) => e.path.toLowerCase().includes(filter.trim().toLowerCase()))
    : entries;

  const notice = target ? archivedNotice({ archiveId: target.archiveId, root: target.root, kind: target.kind, fileName: target.fileName }) : null;

  return (
    <div>
      {notice && (
        <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
          <div className="text-[12px] text-amber-900 leading-relaxed">{notice.message}</div>
        </div>
      )}

      {!zip ? (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          className={`rounded-2xl border-2 border-dashed p-8 text-center cursor-pointer transition-colors ${
            dragging ? "border-[var(--color-accent)] bg-[var(--color-accent)]/5" : "border-[var(--color-border-strong)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)]"
          }`}
        >
          <input ref={inputRef} type="file" accept=".zip,application/zip" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); }} />
          {loading ? (
            <div className="inline-flex items-center gap-2 text-sm text-[var(--color-text-muted)]"><Loader2 className="w-4 h-4 animate-spin" /> Reading archive…</div>
          ) : (
            <>
              <UploadCloud className="w-8 h-8 mx-auto text-[var(--color-text-faint)] mb-2" />
              <div className="text-sm font-bold text-[var(--color-text)]">Drop the backup .zip here, or click to choose</div>
              <div className="text-[11px] text-[var(--color-text-muted)] mt-1 inline-flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" /> Opened in your browser only — never uploaded or re-saved.
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[20rem_1fr] gap-3">
          {/* File list */}
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden flex flex-col max-h-[70vh]">
            <div className="px-3 py-2 border-b border-[var(--color-border)] flex items-center gap-2">
              <Search className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" />
              <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Filter ${entries.length} files…`}
                className="flex-1 bg-transparent text-xs text-[var(--color-text)] outline-none" />
              <button onClick={clearAll} title="Close archive (discards it)" className="p-1 rounded text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"><X className="w-3.5 h-3.5" /></button>
            </div>
            <div className="overflow-y-auto divide-y divide-[var(--color-border)]">
              {shown.map((e) => {
                const k = kindOf(e.name);
                const Icon = k === "pdf" ? FileText : k === "image" ? ImageIcon : FileIcon;
                const active = preview?.name === e.name;
                return (
                  <button key={e.path} onClick={() => void openEntry(zip, e.path, e.name)}
                    className={`w-full px-3 py-2 flex items-center gap-2 text-left transition-colors ${active ? "bg-[var(--color-accent)]/10" : "hover:bg-[var(--color-surface-2)]"}`}>
                    <Icon className="w-3.5 h-3.5 text-[var(--color-text-muted)] shrink-0" />
                    <span className="text-[11px] text-[var(--color-text)] truncate flex-1" title={e.path}>{e.name}</span>
                  </button>
                );
              })}
              {shown.length === 0 && <div className="px-3 py-4 text-[11px] text-[var(--color-text-muted)] text-center">No files match.</div>}
            </div>
          </div>

          {/* Preview */}
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden flex flex-col min-h-[24rem] max-h-[70vh]">
            {previewBusy ? (
              <div className="flex-1 grid place-items-center text-sm text-[var(--color-text-muted)]"><Loader2 className="w-4 h-4 animate-spin" /></div>
            ) : preview ? (
              <>
                <div className="px-3 py-2 border-b border-[var(--color-border)] flex items-center gap-2">
                  <Eye className="w-3.5 h-3.5 text-[var(--color-text-muted)] shrink-0" />
                  <span className="text-xs font-bold text-[var(--color-text)] truncate flex-1">{preview.name}</span>
                  <a href={preview.url} download={preview.name} className="inline-flex items-center gap-1 text-[11px] font-bold text-[var(--color-accent)] hover:underline"><Download className="w-3 h-3" /> Save a copy</a>
                </div>
                <div className="flex-1 overflow-auto bg-[var(--color-surface-2)] grid place-items-center">
                  {preview.kind === "pdf" ? (
                    <iframe src={preview.url} title={preview.name} className="w-full h-full min-h-[24rem]" />
                  ) : preview.kind === "image" ? (
                    // eslint-disable-next-line @next/next/no-img-element -- in-memory object URL, not a remote asset
                    <img src={preview.url} alt={preview.name} className="max-w-full max-h-full object-contain" />
                  ) : (
                    <div className="text-center p-6">
                      <FileIcon className="w-10 h-10 mx-auto text-[var(--color-text-faint)] mb-2" />
                      <div className="text-xs text-[var(--color-text-muted)] mb-3">This file type can&apos;t preview inline.</div>
                      <a href={preview.url} download={preview.name} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-white bg-[var(--color-accent)] hover:opacity-90"><Download className="w-3.5 h-3.5" /> Open / download</a>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="flex-1 grid place-items-center text-center p-6">
                <div>
                  <Eye className="w-8 h-8 mx-auto text-[var(--color-text-faint)] mb-2" />
                  <div className="text-sm text-[var(--color-text-muted)]">Pick a file to view it.</div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
        </div>
      )}
    </div>
  );
}
